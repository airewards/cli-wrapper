/**
 * Local credential/config store for the terminal proxy.
 *
 * The wrapper runs as a short-lived child of the user's interactive shell, so
 * it has no session cookie and no keychain access. It authenticates with the
 * developer API key (`air_dev_…`) exactly like the VS Code extension does,
 * read from either the environment or `~/.airewards/config.json`.
 *
 * The file is created with owner-only permissions (0600 inside a 0700 dir)
 * because it holds a bearer credential. Reading never throws: a missing,
 * unreadable, or malformed config simply means "no key", which downgrades the
 * wrapper to a transparent pass-through rather than breaking the command.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Production API origin, matching `@airewards/agent-sdk`. Env-driven so no
 * hostname is hardcoded in source. */
export const DEFAULT_BASE_URL = process.env.AIREWARDS_API_URL ?? 'https://www.airewards.tech';

export const CONFIG_DIR = join(homedir(), '.airewards');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/**
 * Current ad plus its dwell bookkeeping, shared by every Claude Code status-line
 * tick. Each tick is a fresh process, so this file *is* the hook's memory —
 * see `claude-hook.ts`.
 */
export const AD_CACHE_FILE = join(CONFIG_DIR, 'ad_cache.json');

/**
 * Launcher that Claude Code's `statusLine` command points at. It lives here
 * rather than in the package directory so the path recorded in the user's
 * `settings.json` stays stable across reinstalls — see `claude-native.ts`.
 */
export const HOOK_SCRIPT_FILE = join(CONFIG_DIR, 'claude-hook.js');

/**
 * The `statusLine` we displaced when installing ours, saved verbatim.
 *
 * Claude Code has exactly one status-line slot, so a user who already runs a
 * custom HUD there loses it the moment we take the slot. Keeping a copy is what
 * turns that replacement into a chain: the hook runs the saved command on every
 * tick and prints its output alongside the ad, and `setup --remove` puts it back
 * in `settings.json`. Absent when there was nothing to displace.
 */
export const PREV_STATUSLINE_FILE = join(CONFIG_DIR, 'prev-statusline.json');

export interface CliConfig {
  /** Developer API key, or undefined when the user has not run `airewards setup --api-key`. */
  readonly apiKey: string | undefined;
  /** API origin, normalised without a trailing slash. */
  readonly baseUrl: string;
}

interface StoredConfig {
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Resolve the effective config. Environment variables win over the file so a
 * single command can be pointed at a local backend or a scratch key without
 * touching the user's stored credentials.
 */
export function loadConfig(): CliConfig {
  const stored = readStoredConfig();
  const baseUrl = process.env.AIREWARDS_API_BASE_URL ?? stored.baseUrl ?? DEFAULT_BASE_URL;

  return {
    apiKey: process.env.AIREWARDS_API_KEY ?? stored.apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
  };
}

/** Persist `apiKey`, preserving any other keys already in the file. */
export function saveApiKey(apiKey: string): void {
  const next: StoredConfig = { ...readStoredConfig(), apiKey };

  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  // `mode` on writeFileSync is ignored when the file already exists, so tighten
  // the permissions explicitly on every write.
  chmodSync(CONFIG_FILE, 0o600);
}

function readStoredConfig(): StoredConfig {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_FILE, 'utf8');
  } catch {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};

    const { apiKey, baseUrl } = parsed as StoredConfig;
    return {
      ...(typeof apiKey === 'string' && apiKey.length > 0 ? { apiKey } : {}),
      ...(typeof baseUrl === 'string' && baseUrl.length > 0 ? { baseUrl } : {}),
    };
  } catch {
    return {};
  }
}
