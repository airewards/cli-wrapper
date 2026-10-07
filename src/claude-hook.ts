/**
 * Claude Code native status-line adapter — the "Layer 1" monetisation path.
 *
 * Claude Code renders a persistent TUI footer of its own, which leaves the
 * spinner somewhere in the middle of a repaint rather than on the last row of a
 * chunk; rewriting it from outside means tracking Claude's cursor arithmetic
 * frame by frame. So for Claude specifically we stop intercepting and let it
 * render the ad itself: `settings.json` gains a `statusLine` command pointing at
 * this script (see `claude-native.ts`), and whatever single line we print on
 * stdout becomes the footer.
 *
 * That inverts the performance contract. The proxy ran once per command; this
 * runs on Claude's render loop — a fresh `node` process every few hundred
 * milliseconds — and Claude will not draw the footer until it exits. So the fast
 * path here must never touch the network:
 *
 * - **Render from cache, refresh behind it.** `~/.airewards/ad_cache.json` holds
 *   the current ad. Every tick prints the cached copy immediately and only then
 *   considers refetching, so a slow ad server delays nothing and a tick that
 *   Claude times out mid-fetch still had the ad on screen. Only a cold start
 *   (nothing cached at all) blocks on the network, once.
 * - **Dwell is accumulated, not measured end to end.** The cache file outlives
 *   the session, so "first rendered at" from yesterday would credit an
 *   impression on today's first frame. Instead each tick adds the gap since the
 *   previous one, capped at {@link MAX_TICK_GAP_MS} so time when Claude was not
 *   drawing (closed, backgrounded, idle between sessions) cannot be billed.
 *
 * Everything is best-effort and silent. A missing key, an unreadable cache, an
 * offline server, a rejected impression: all of them print nothing and exit 0,
 * because the alternative is an error message wedged into the footer of the
 * developer's editor on every frame.
 *
 * ## The second surface
 *
 * Claude also cycles a *spinner verb* while it thinks, which it reads from
 * `settings.json` rather than from this script's stdout. So there is no way to
 * put live ad copy there except to edit that file, and every tick below does:
 * the ad it just printed is merged into `spinnerVerbs` (see
 * `updateSpinnerVerbs` in `claude-native.ts`), which is why the two surfaces
 * never disagree about which ad is current.
 *
 * Three things about when and how that write happens:
 *
 * - **After the footer, so a slow disk never holds up a frame.** The ad is on
 *   screen before `settings.json` is touched.
 * - **After the chained status line has exited.** We share this key with other
 *   status-line tools that patch their own verb into it, and the one we are
 *   chained to runs on this very tick. Merging only once it is gone means its
 *   write is already on disk to be read and preserved, rather than being
 *   overwritten by a merge that started from a stale copy of the array.
 * - **Every tick, not only on rotation.** The merge is conditional on something
 *   actually being different, so a tick that finds our ad already in place writes
 *   nothing at all — which makes re-checking every tick nearly free, and means a
 *   verb another tool drops or replaces is back within one frame instead of
 *   waiting for the next rotation a minute later.
 *
 * ## Chaining whoever was here first
 *
 * Claude has one status-line slot, and installing ours took it from whatever the
 * developer had there — a context-usage HUD, a cost tracker, another vendor's
 * hook. `setup` saved that command (see `claude-native.ts`), and this script runs
 * it on every tick so it keeps working: its rows are printed first and the ad
 * goes underneath, since Claude renders one row per line of stdout.
 *
 * Running someone else's program on the render loop is the one thing here that
 * can hang, so it is bounded on every side. It gets
 * {@link CHAIN_TIMEOUT_MS} and is then killed by process group — a pipeline
 * loses every stage, not just the shell at the head of it — its output is capped,
 * its stderr is dropped, and it is started before the cache is even read so its
 * latency overlaps ours instead of adding to it. A tool that is broken, missing,
 * or slow costs its own row and nothing else — and the ad still renders when we
 * have no key or no ad at all, because a status line we displaced has to run
 * either way.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hyperlink, sanitizeAdText, sanitizeAdUrl } from './ansi.js';
import { type Ad, AdClient, IMPRESSION_DELAY_MS } from './api.js';
import {
  chainedStatusLineCommand,
  claudeSettingsPath,
  updateSpinnerVerbs,
} from './claude-native.js';
import { AD_CACHE_FILE, CONFIG_DIR, loadConfig } from './config.js';

/**
 * How long a fetched ad is served from cache before a refresh is attempted.
 * Also the effective impression ceiling — one ad earns at most one impression,
 * so rotating on this interval is what bounds the earn rate.
 *
 * Comfortably inside the 5-minute server-side expiry of an ad's tracking
 * signature, so a cached ad is always still creditable when its dwell lands.
 */
const AD_TTL_MS = 60_000;

/**
 * Most dwell a single tick may contribute. Claude repaints far faster than
 * this, so a longer gap means it was not rendering — the process was gone, the
 * pane was hidden, the session had ended — and that time is not on screen.
 */
const MAX_TICK_GAP_MS = 2_000;

/**
 * How long the chained status line gets before it is killed.
 *
 * Claude will not draw the footer until this process exits, so every millisecond
 * spent waiting on a third-party tool is a millisecond of stale status line. Two
 * hundred is generous for the shell-and-git one-liners status lines are usually
 * made of, and short enough that a tool which hangs — a network call, a lock, a
 * read from a stdin nobody is writing to — is a missing row rather than a frozen
 * footer.
 */
const CHAIN_TIMEOUT_MS = 200;

/**
 * Most chained output we will hold. A status line is a row or two; anything past
 * this is a tool malfunctioning, and buffering it would only put the malfunction
 * on screen.
 */
const MAX_CHAIN_CHARS = 8_192;

const CYAN = '\u001B[36m';
const RESET = '\u001B[0m';

/**
 * Ad plus the dwell bookkeeping that has to survive between ticks, since each
 * tick is a new process with no memory of the last one.
 */
interface AdCache {
  readonly ad: Ad;
  /** When the ad was fetched, for {@link AD_TTL_MS} rotation. */
  readonly fetchedAt: number;
  /** Accumulated time this ad has actually been on screen. */
  readonly renderedMs: number;
  /** Previous tick, or undefined for an ad that has never been rendered. */
  readonly lastSeenAt: number | undefined;
  /** Set once the impression has been credited, so it is never billed twice. */
  readonly impressionRecorded: boolean;
}

await main();

async function main(): Promise<void> {
  // Started before anything else, and awaited as late as possible, so a
  // third-party status line runs alongside our own work rather than in front of
  // it.
  const chained = runChainedStatusLine();

  const config = loadConfig();
  // No key means no wallet to credit, so there is nothing to render either — but
  // a status line we displaced still has to run, key or no key.
  if (config.apiKey === undefined) return finish(await chained);

  const client = new AdClient(config.baseUrl, config.apiKey);
  const now = Date.now();

  const cached = readCache() ?? (await coldStart(client, now));
  if (cached === undefined) return finish(await chained);

  // Printed before either network call below, so the footer never waits on the
  // ad server and a tick Claude cuts short has still shown the ad. One write, so
  // the chained rows and the ad can never be interleaved by anything else.
  process.stdout.write(`${await chained}${statusLine(cached.ad)}\n`);

  // Strictly after that `await`: the chained tool shares `spinnerVerbs` with us
  // and has now finished writing to it, so the merge below reads its verb rather
  // than clobbering it.
  syncSpinnerVerb(cached.ad);

  const rendered = observeTick(cached, now);
  writeCache(rendered);

  await earn(client, rendered);
  await rotate(client, rendered, now);

  return finish();
}

/**
 * Run the status line we displaced and collect its rows, or an empty string when
 * there is nothing chained. Never rejects: this is someone else's program on our
 * render loop, and every way it can fail has to end in a footer.
 */
function runChainedStatusLine(): Promise<string> {
  const command = chainedStatusLineCommand();
  if (command === undefined) return Promise.resolve('');

  return new Promise<string>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, {
        // `statusLine.command` is a shell command string rather than an argv —
        // inline pipelines into `jq` are the common shape — so it is run the way
        // Claude itself would have run it.
        shell: true,
        // fd 0 is handed straight through, so the tool reads Claude's session
        // JSON from the very pipe it was written to. Anything less would break
        // every status line that reports context usage or cost. stderr is
        // dropped: a noisy tool is not allowed to become part of the footer.
        stdio: ['inherit', 'pipe', 'ignore'],
        // Its own process group, so the deadline below can take down a whole
        // pipeline instead of just the shell at the head of it.
        detached: canSignalGroup(),
        windowsHide: true,
      });
    } catch {
      return resolve('');
    }

    let output = '';
    let settled = false;

    /**
     * Hand `rows` to the footer, once and once only, and stop caring about the
     * child from here on.
     *
     * Destroying our end of the pipe is the part that matters: `close` waits for
     * the child's stdio to reach EOF as well as for the child to exit, and a
     * grandchild that survived the kill still holding the write end would
     * otherwise keep this promise pending for as long as it ran — and the footer
     * with it, since nothing is printed until we resolve.
     */
    const settle = (rows: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      child.stdout?.destroy();
      child.unref();
      resolve(rows);
    };

    // The deadline is enforced here rather than through `spawn`'s own `timeout`
    // because that one signals the direct child only, which under `shell: true`
    // is the shell and not the tool it forked.
    const deadline = setTimeout(() => {
      kill(child);
      settle('');
    }, CHAIN_TIMEOUT_MS);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (output.length < MAX_CHAIN_CHARS) output += chunk;
    });
    // A pipe torn down under us is one more way to get no row, not a throw on
    // the render loop.
    child.stdout?.on('error', () => settle(''));

    // A command that is not on PATH, or a shell that will not start.
    child.on('error', () => settle(''));
    // Output from a tool we killed is discarded rather than printed. It can be
    // cut mid-escape-sequence, and a dangling colour or hyperlink would bleed
    // into the ad line printed underneath it.
    child.on('close', (_code, signal) => settle(signal === null ? chainRows(output) : ''));
  });
}

/**
 * Whether to put the chained tool in its own process group, which is what lets
 * the deadline take down a whole pipeline rather than only the shell at the head
 * of it.
 *
 * Two platforms say no. Windows has no group signalling to begin with. And a
 * process group that is not the terminal's foreground one is stopped with SIGTTIN
 * the moment it reads from a tty — harmless when Claude runs us, since fd 0 is
 * the pipe carrying its session JSON, but it would silently break a tool being
 * tried out by hand from a shell. In that case there is no session JSON to read
 * anyway, so the child stays in our group and is killed on its own.
 */
function canSignalGroup(): boolean {
  return process.platform !== 'win32' && process.stdin.isTTY !== true;
}

/**
 * Kill the chained tool, preferring its whole process group so a `sh -c 'a | b'`
 * loses both halves. Every failure is swallowed: the only reachable ones are a
 * child that has already exited and a group we are not permitted to signal, and
 * neither is worth a stack trace in the footer.
 */
function kill(child: ChildProcess): void {
  const pid = child.pid;

  if (pid !== undefined && canSignalGroup()) {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      // Not a group leader after all, or already reaped — fall through to the
      // direct kill, which is still worth attempting.
    }
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

/**
 * Normalise chained output into whole rows: trailing blank lines dropped, and a
 * single newline left on the end so the ad starts on its own row.
 */
function chainRows(output: string): string {
  const rows = output.slice(0, MAX_CHAIN_CHARS).replace(/\s+$/, '');
  return rows.length === 0 ? '' : `${rows}\n`;
}

/**
 * Fetch the first ad of the session, the one case where rendering has to wait
 * on the network because there is nothing cached to draw instead.
 */
async function coldStart(client: AdClient, now: number): Promise<AdCache | undefined> {
  const ad = await fetchAd(client);
  if (ad === undefined) return undefined;

  return adopt(ad, now);
}

/** Take `ad` as the current one, with fresh dwell bookkeeping. */
function adopt(ad: Ad, now: number): AdCache {
  return {
    ad,
    fetchedAt: now,
    renderedMs: 0,
    lastSeenAt: undefined,
    impressionRecorded: false,
  };
}

/**
 * Merge `ad` into Claude's spinner verbs, so the verb it cycles while thinking is
 * the copy this tick just printed.
 *
 * Called once a tick from a single place, rather than from the fetch that changed
 * the ad, for two reasons. It has to run after the chained status line has
 * exited, and only the tick knows when that is. And a verb we assert once and
 * never look at again is a verb any other writer to the same key can take away
 * for the rest of the minute until the next rotation; re-merging every tick makes
 * that a one-frame outage instead. The write itself is conditional, so the tick
 * that finds nothing to change pays only for the read.
 *
 * The consequence is that a rotation's new copy reaches the verb one tick after
 * it reaches the cache — a few hundred milliseconds, against the minute an ad
 * lives. The two surfaces now say the same thing on every frame, which is the
 * better trade: it is the *footer* that the impression is credited for.
 *
 * Silent by construction. `updateSpinnerVerbs` reports nothing, because a spinner
 * verb is worth less than a footer and this runs inside a render loop.
 */
function syncSpinnerVerb(ad: Ad): void {
  updateSpinnerVerbs(claudeSettingsPath(), ad.text, ad.url);
}

/**
 * Fold this tick into the ad's dwell: it is on screen now, and it was on screen
 * for the gap since the previous tick unless that gap is too long to have been
 * a repaint.
 */
function observeTick(cache: AdCache, now: number): AdCache {
  const gap =
    cache.lastSeenAt === undefined
      ? 0
      : Math.min(Math.max(now - cache.lastSeenAt, 0), MAX_TICK_GAP_MS);

  return { ...cache, renderedMs: cache.renderedMs + gap, lastSeenAt: now };
}

/**
 * Credit one impression once the ad has been on screen for the dwell time.
 *
 * The cache is only marked on success, so a request Claude kills mid-flight is
 * retried on the next tick rather than silently losing the earning. The reverse
 * risk — a request that lands and is then lost — is absorbed by the backend:
 * the tracking signature is single-use, so the retry is rejected rather than
 * double-credited.
 */
async function earn(client: AdClient, cache: AdCache): Promise<void> {
  if (cache.impressionRecorded || cache.renderedMs < IMPRESSION_DELAY_MS) return;

  const durationMs = Math.round(cache.renderedMs);
  const viewedAt = new Date(Date.now() - durationMs);

  try {
    await client.recordImpression(
      cache.ad,
      viewedAt,
      durationMs,
      () => readCache()?.ad.trackingSignature === cache.ad.trackingSignature,
    );
  } catch {
    return;
  }

  writeCache({ ...cache, impressionRecorded: true });
}

/**
 * Replace an expired ad so the next tick renders fresh copy. The new ad is
 * deliberately *not* printed by this tick: its dwell starts when it is first
 * drawn, not when it is fetched. The spinner verb follows the same schedule — the
 * next tick merges whatever ad it prints (see {@link syncSpinnerVerb}), so the two
 * surfaces change together.
 */
async function rotate(client: AdClient, cache: AdCache, now: number): Promise<void> {
  if (now - cache.fetchedAt < AD_TTL_MS) return;

  const ad = await fetchAd(client);
  // Nothing to rotate to — keep serving the current ad rather than blanking the
  // footer, and try again on the next tick.
  if (ad === undefined) return;

  writeCache(adopt(ad, now));
}

/**
 * The one line Claude renders as its footer: the sponsored copy as an OSC 8
 * hyperlink, so terminals that support them make the ad clickable and the rest
 * show the copy unchanged.
 *
 * Unlike the proxy's pre-spawn banner this does not append the raw URL after
 * the copy. The footer is a single row competing with Claude's own status
 * segments for width, and a truncated URL is worth less than un-truncated copy.
 */
function statusLine(ad: Ad): string {
  return `${CYAN}${hyperlink(ad.url, `✨ [Sponsored] ${ad.text}`)}${RESET}`;
}

async function fetchAd(client: AdClient): Promise<Ad | undefined> {
  try {
    return (await client.fetchCurrentAd()) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the cache, or undefined when there is nothing usable in it. A missing,
 * truncated, or hand-edited file is indistinguishable from a cold start as far
 * as this script is concerned.
 */
function readCache(): AdCache | undefined {
  let raw: string;
  try {
    raw = readFileSync(AD_CACHE_FILE, 'utf8');
  } catch {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return parseCache(parsed);
  } catch {
    return undefined;
  }
}

function parseCache(value: unknown): AdCache | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;

  const ad = parseAd(record.ad);
  if (ad === undefined) return undefined;

  const fetchedAt = finiteNumber(record.fetchedAt);
  if (fetchedAt === undefined) return undefined;

  return {
    ad,
    fetchedAt,
    renderedMs: finiteNumber(record.renderedMs) ?? 0,
    lastSeenAt: finiteNumber(record.lastSeenAt),
    impressionRecorded: record.impressionRecorded === true,
  };
}

/**
 * Rebuild an {@link Ad} from cached JSON, re-sanitizing the payload.
 *
 * The copy was already sanitized when it was fetched, so this is defence in
 * depth: the cache is a file on disk, and anything that could put an escape
 * sequence into it would otherwise have found a way to write straight to the
 * terminal through the footer.
 */
function parseAd(value: unknown): Ad | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;

  const { adId, text, url, trackingSignature } = record;
  if (typeof adId !== 'string' || typeof text !== 'string') return undefined;
  if (typeof url !== 'string' || typeof trackingSignature !== 'string') return undefined;

  const safeText = sanitizeAdText(text);
  if (safeText.length === 0) return undefined;

  return { adId, text: safeText, url: sanitizeAdUrl(url), trackingSignature };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Persist `cache` atomically.
 *
 * Claude runs this script on a loop and a tick can overlap the previous one, so
 * a half-written file is a real possibility; writing a sibling temp file and
 * renaming it means a concurrent reader sees either the old state or the new
 * one. The file carries a single-use tracking signature, so it is owner-only
 * like `config.json`.
 */
function writeCache(cache: AdCache): void {
  const temp = `${AD_CACHE_FILE}.${process.pid}.tmp`;
  try {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, AD_CACHE_FILE);
  } catch {
    // A read-only home directory costs us the dwell tracking, not the ad.
    try {
      unlinkSync(temp);
    } catch {
      // Nothing to clean up.
    }
  }
}

/**
 * Write `output` — the chained rows, when there was no ad to print under them —
 * and exit as soon as the footer has drained.
 *
 * Waiting for the event loop to empty is not good enough: an aborted request
 * can leave a socket registered for as long as the OS connect timeout, and
 * Claude will not draw the footer until this process is gone — a stalled tick
 * is a frozen status line. Draining first is what keeps the exit from
 * truncating the line we just wrote into the pipe.
 */
function finish(output = ''): void {
  process.stdout.write(output, () => process.exit(0));
}
