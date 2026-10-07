/**
 * Minimal AIRewards API client for the terminal proxy.
 *
 * Zero runtime dependencies by design — native `fetch` (Node 18+) only — so
 * the wrapper stays a single-file install that can sit in front of any binary.
 * Every request carries a hard timeout: the wrapper is in the critical path of
 * the developer's command, so a hung ad server must never delay their shell.
 */

import { hostname, userInfo } from 'node:os';
import { sanitizeAdText, sanitizeAdUrl } from './ansi.js';

/** The surface this client reports on, per `TARGET_PLATFORMS` in `@airewards/types`. */
export const PLATFORM = 'cli';

/**
 * Minimum dwell time before an impression counts. Must be >= the backend's
 * `duration_ms` minimum (5s) or the payload is rejected with a 400.
 */
export const IMPRESSION_DELAY_MS = 5_000;

/** Requests are abandoned past this; an unreachable API degrades to "no ad". */
const REQUEST_TIMEOUT_MS = 10_000;

/** Sponsored message returned by `GET /v1/ads/current?platform=cli`. */
export interface Ad {
  readonly adId: string;
  /**
   * Display copy, already stripped of control characters. Safe to write
   * straight to a terminal; never empty.
   */
  readonly text: string;
  /**
   * Click destination, already stripped of anything that could break out of
   * the OSC 8 sequence that carries it. May be empty or non-`http(s)`, in
   * which case `hyperlink` declines to link the ad.
   */
  readonly url: string;
  /**
   * Single-use signature minted per fetch; echoing it back is what makes the
   * impression creditable. It expires server-side after 5 minutes.
   */
  readonly trackingSignature: string;
}

interface SuccessEnvelope<T> {
  success: true;
  data: T;
}

interface WireAd {
  ad_id: string;
  text: string;
  url: string;
  tracking_signature: string;
}

export class AdClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  /**
   * Fetch the ad currently eligible for the `cli` platform. Returns null when
   * the backend has nothing to show (404) or rejects the key — callers treat
   * every null as "run the command with no ad", never as an error to surface.
   *
   * The payload is sanitized here, at the one point every ad enters the
   * process, rather than at each of the two places that print one. Ad copy is
   * attacker-controlled text bound for a terminal that treats bytes as
   * commands, so it must never exist in an untrusted form downstream of this
   * method.
   *
   * `signal` lets the caller drop the request the instant the wrapped command
   * exits. Without it, a hung ad server would hold the event loop open and
   * delay the developer's shell long after their command finished.
   */
  async fetchCurrentAd(signal?: AbortSignal): Promise<Ad | null> {
    const response = await this.request(
      'GET',
      `/v1/ads/current?platform=${PLATFORM}`,
      undefined,
      signal,
    );
    if (!response.ok) return null;

    const body = (await response.json()) as SuccessEnvelope<WireAd>;
    const text = sanitizeAdText(body.data.text);
    // Copy that was nothing but control characters leaves us with a sponsored
    // line that says nothing. Treat it as "no ad" rather than print an empty
    // one — and, in the injector's case, rather than borrow the child's status
    // line to show it.
    if (text.length === 0) return null;

    return {
      adId: body.data.ad_id,
      text,
      url: sanitizeAdUrl(body.data.url),
      trackingSignature: body.data.tracking_signature,
    };
  }

  /** Record one impression for `ad`, crediting the developer's wallet. */
  async recordImpression(
    ad: Ad,
    _viewedAt: Date,
    durationMs: number,
    isVisible: () => boolean | Promise<boolean> = () => true,
  ): Promise<void> {
    // Impressions are rejected until the developer has a device on record.
    await this.ensureDeviceRegistered();

    const created = await this.request('POST', '/v2/impressions/challenges', {
      ad_id: ad.adId,
      tracking_signature: ad.trackingSignature,
      provider: PLATFORM.toUpperCase(),
      platform: PLATFORM,
      conversation_id: null,
    });
    if (!created.ok) throw new Error(`Impression challenge failed (${created.status})`);
    const payload = (await created.json()) as SuccessEnvelope<{
      impression_id: string;
      challenge: string;
    }>;
    // The server clock and arrival spacing are authoritative; client timestamps
    // and the caller's local duration are correlation hints only.
    for (
      let sequence = 0;
      sequence < Math.max(6, Math.ceil(durationMs / 1_000) + 1);
      sequence += 1
    ) {
      if (sequence > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
      const visible = await isVisible();
      const heartbeat = await this.request(
        'POST',
        `/v2/impressions/${payload.data.impression_id}/heartbeats`,
        {
          challenge: payload.data.challenge,
          sequence,
          visible,
        },
      );
      if (!heartbeat.ok) throw new Error(`Impression heartbeat failed (${heartbeat.status})`);
      if (!visible) throw new Error('Impression display ended before evidence was complete');
    }
    const completed = await this.request(
      'POST',
      `/v2/impressions/${payload.data.impression_id}/complete`,
      {
        challenge: payload.data.challenge,
      },
    );
    if (!completed.ok) throw new Error(`Impression completion failed (${completed.status})`);
  }

  /**
   * One registration attempt per process; the endpoint is idempotent
   * server-side. `DESKTOP_AGENT` is the closest existing device type for a
   * terminal — the device registry has no dedicated CLI type yet.
   */
  private deviceRegistration: Promise<void> | undefined;

  private ensureDeviceRegistered(): Promise<void> {
    this.deviceRegistration ??= this.registerDevice().catch((error: unknown) => {
      // Allow a later impression in this process to retry registration.
      this.deviceRegistration = undefined;
      throw error;
    });
    return this.deviceRegistration;
  }

  private async registerDevice(): Promise<void> {
    const response = await this.request('POST', '/v1/devices/register', {
      type: 'DESKTOP_AGENT',
      fingerprint: deviceFingerprint(),
    });

    if (!response.ok) {
      throw new Error(`Device registration failed (${response.status})`);
    }
  }

  /**
   * Issue one request, bounded by {@link REQUEST_TIMEOUT_MS} and, optionally,
   * by a caller-supplied signal.
   *
   * The two are merged by hand rather than with `AbortSignal.any`, which only
   * exists from Node 20 — this package supports 18.
   */
  private request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();

    const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
    if (signal?.aborted === true) abort();
    else signal?.addEventListener('abort', abort, { once: true });

    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    }).finally(() => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    });
  }
}

/**
 * Stable per-machine identifier. Every wrapped command is a fresh process, so
 * this must not include anything process-scoped (pid, tty) or the developer
 * would accrue a new device row per invocation.
 */
function deviceFingerprint(): string {
  let user = 'unknown';
  try {
    user = userInfo().username;
  } catch {
    // No passwd entry (some containers); the hostname alone still identifies
    // the machine well enough for device dedupe.
  }
  return `cli-wrapper:${user}@${hostname()}`.slice(0, 255);
}
