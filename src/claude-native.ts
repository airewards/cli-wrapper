/**
 * Native Claude Code adapter installer — the `settings.json` half of Layer 1.
 *
 * `claude-hook.ts` can only render an ad if Claude is asking it to, so setup has
 * to write two things:
 *
 * 1. **A launcher at a stable path.** `~/.airewards/claude-hook.js` is a
 *    one-line shim that dynamically imports the compiled hook out of wherever
 *    this package happens to be installed. The indirection exists because the
 *    path ends up recorded in the user's `settings.json`, and a global package
 *    directory (pnpm's content-addressed store, an nvm-versioned prefix) moves
 *    on upgrade; a shim keeps the recorded path stable and, being a bare
 *    `import()` expression, is valid whether Node treats it as ESM or CJS.
 * 2. **Two settings keys.** `statusLine` points Claude at the launcher, and
 *    `spinnerVerbs` gains a sponsored thinking verb.
 *
 * Setup only seeds `spinnerVerbs` with a placeholder, because it has no ad in
 * hand and blocking install on the network would be the wrong trade. The live
 * copy is patched in later by the status-line hook through
 * {@link updateSpinnerVerbs}, which is why the settings reader and writer are
 * exported rather than private to this module: both writers have to agree on
 * what "safe" means, and there must be exactly one implementation of it.
 *
 * ## Someone else's spinner verb
 *
 * `spinnerVerbs.verbs` is an array, and we are not the only tool that writes to
 * it: other monetised status lines patch their own copy into the same key from
 * the same render loop. Two hooks each replacing the whole array is a write-war —
 * whichever ran last wins the frame, and the spinner flickers between vendors as
 * they take turns clobbering each other.
 *
 * So every write here is a *merge* rather than a replacement (see
 * {@link mergeSponsoredVerb}): verbs that are not ours are carried over
 * untouched, verbs that are ours are collapsed to the one live ad, and ours goes
 * last. Both surfaces then coexist — Claude cycles through their verb and ours —
 * and neither tool has anything left to overwrite.
 *
 * The same rule governs the other direction, because a key we share is not a key
 * we may delete: `--remove` strips our verbs out of the array and only drops the
 * key when nothing else was in it.
 *
 * ## Someone else's status line
 *
 * Claude has exactly one `statusLine` slot, so installing ours displaces
 * whatever was in it — and plenty of developers have a custom HUD or another
 * vendor's hook there already. That slot cannot be shared, but the *command*
 * can: the displaced entry is copied verbatim to `prev-statusline.json`, the
 * hook runs it on every tick and prints its output above the ad
 * (see `claude-hook.ts`), and `--remove` puts it back where it was. Being
 * replaced by us is therefore invisible except for the extra row.
 *
 * One exception, and it is about execution rather than ownership: a displaced
 * status line belonging to *another ad network* is captured and restored like
 * any other, but not run from our loop (see {@link COMPETITOR_MARKERS}). Chaining
 * exists so a developer keeps their own HUD; extending it to a competitor would
 * mean rendering their ad inside the footer we are paid for. The entry stays in
 * the user's file and comes back on `--remove` — we decline to run it, we do not
 * delete it.
 *
 * ## Keeping the slot
 *
 * Nothing stops another tool from writing `settings.json` after we do, and a
 * displaced hook renders nothing. So `airewards run claude` repairs the install
 * immediately before Claude starts ({@link enforceNativeHook}), which is the last
 * moment that still counts for the session about to begin. That path only ever
 * restores an install that already exists: it is gated on our own launcher being
 * on disk, so `--remove` is final and a user who never opted in is never opted in
 * by it.
 *
 * Editing `settings.json` is as invasive as editing a shell rc file, so it
 * follows the same rules as `setup.ts`:
 *
 * - **Non-destructive.** The file is parsed and re-serialised with only our two
 *   keys touched; every other setting (`env`, `permissions`, `model`, hooks,
 *   unknown future keys) survives byte-equivalently.
 * - **Reversible.** `--remove` deletes only the keys still recognisable as ours,
 *   and the pristine file is copied to `settings.json.airewards.bak` before the
 *   first edit.
 * - **Cautious.** A file we cannot parse is left alone entirely, and we never
 *   point Claude at a hook that is not on disk.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeAdText, sanitizeAdUrl } from './ansi.js';
import { AD_CACHE_FILE, CONFIG_DIR, HOOK_SCRIPT_FILE, PREV_STATUSLINE_FILE } from './config.js';

/** The command Claude Code installs as, and the only one monetised natively. */
export const CLAUDE_COMMAND = 'claude';

/** Executable suffixes to ignore when matching a command name. */
const EXECUTABLE_SUFFIX = /\.(exe|cmd|bat|ps1)$/;

/**
 * Whether `command` is Claude Code — the one agent `airewards run` relays
 * untouched, because the native hook is already monetising it from the inside
 * and a second ad would be both redundant and double-counted.
 */
export function usesNativeAdapter(command: string): boolean {
  return basename(command).toLowerCase().replace(EXECUTABLE_SUFFIX, '') === CLAUDE_COMMAND;
}

/**
 * Prefix every sponsored spinner verb carries.
 *
 * It doubles as the ownership marker: the rest of the verb is live ad copy that
 * changes every time the hook rotates, so matching on a whole verb string would
 * mean `--remove` stopped recognising its own installation the moment the first
 * ad landed. The prefix is the only part that is ours and constant.
 */
const SPONSORED_VERB_PREFIX = '✨ [Sponsored] ';

/**
 * Verb `setup` seeds, standing in until the hook's first fetch replaces it.
 * Setup runs before any ad has been fetched and must not block on the network to
 * get one, so the placeholder is what the spinner shows for the first tick or
 * two of the next Claude session.
 */
const FALLBACK_VERB = `${SPONSORED_VERB_PREFIX}Fetching ad...`;

/**
 * The sponsored verb for `ad`, as plain text.
 *
 * Deliberately unlike the hook's status line, which wraps the same copy in an
 * OSC 8 hyperlink: this string is handed to Claude's own spinner renderer rather
 * than written to the terminal by us, and that renderer measures and truncates
 * what it is given. An escape sequence it does not account for would be
 * mismeasured at best and printed raw at worst, so the URL rides along as text.
 *
 * Both halves are re-sanitized even though `Ad` is sanitized on arrival, for the
 * same defence-in-depth reason `claude-hook.ts` re-sanitizes its cache: the copy
 * reaches this function by way of a file on disk.
 */
function sponsoredVerb(adText: string, adUrl: string): string {
  const text = sanitizeAdText(adText);
  if (text.length === 0) return FALLBACK_VERB;

  const url = sanitizeAdUrl(adUrl);
  return url.length === 0
    ? `${SPONSORED_VERB_PREFIX}${text}`
    : `${SPONSORED_VERB_PREFIX}${text} | ${url}`;
}

/** Whether `value` is a verb this package wrote, live copy or placeholder. */
function isSponsoredVerb(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(SPONSORED_VERB_PREFIX);
}

/**
 * The verb array currently in `settings.json`, or undefined when the key holds
 * something we should not merge into.
 *
 * An absent key and a missing `verbs` are both an empty array — there is nothing
 * of anyone's to preserve, and the key itself is still ours to fill. Treating the
 * two the same is what stops the merge from forfeiting a slot it is entitled to:
 * a file with no `spinnerVerbs` at all is the state a fresh install, a hand-edit
 * or another tool's `--remove` leaves behind, and it is no less mergeable than
 * one holding `{ "mode": "replace" }` and nothing else.
 *
 * A `verbs` that is present but not an array is still left alone entirely: that
 * is not an absence, it is a shape we cannot merge into without guessing what the
 * owner meant by it.
 */
function currentVerbs(spinnerVerbs: unknown): unknown[] | undefined {
  if (spinnerVerbs === undefined) return [];
  if (typeof spinnerVerbs !== 'object' || spinnerVerbs === null) return undefined;

  const verbs = (spinnerVerbs as { verbs?: unknown }).verbs;
  if (verbs === undefined) return [];
  return Array.isArray(verbs) ? verbs : undefined;
}

/**
 * `current` with exactly one sponsored verb in it: `verb`, last.
 *
 * This is the whole of the cooperative merge. Entries that are not ours keep
 * their order and their identity, so another vendor's verb survives our write
 * and Claude cycles through both. Entries that *are* ours collapse to one, so a
 * rotation replaces the previous ad rather than accumulating a session's worth
 * of expired copy — the prefix is what makes those two cases distinguishable,
 * which is the second job it was given.
 *
 * Ours goes last because that is the only position we can hold without fighting
 * for it: a tool that prepends and a tool that appends never contend, while two
 * tools that both want the head of the array trade the slot every frame.
 */
function mergeSponsoredVerb(current: readonly unknown[], verb: string): unknown[] {
  return [...current.filter((entry) => !isSponsoredVerb(entry)), verb];
}

/**
 * Whether two verb arrays are the same, which is what decides if a write happens
 * at all. Compared element by element and by identity: strings by value, and
 * anything foreign we passed through by reference, since a value we did not
 * create is not one we can meaningfully compare any deeper.
 */
function sameVerbs(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * The `spinnerVerbs` object to write: the existing one with `verbs` swapped and
 * every other field it carried left as it was.
 *
 * `mode` is only defaulted when the file did not have one, because a key with
 * verbs and no mode is one Claude ignores — and a placeholder Claude ignores is
 * indistinguishable from a broken install.
 */
function withVerbs(spinnerVerbs: unknown, verbs: unknown[]): ClaudeSpinnerVerbs {
  const existing =
    typeof spinnerVerbs === 'object' && spinnerVerbs !== null
      ? (spinnerVerbs as Record<string, unknown>)
      : {};
  const mode = existing.mode;

  return { ...existing, mode: typeof mode === 'string' ? mode : 'replace', verbs };
}

/**
 * Marker that identifies a `statusLine` as ours on the way back out. Matching on
 * the launcher's filename rather than the full command string means `--remove`
 * still recognises an installation made from a different home directory or
 * hand-edited to add a flag.
 */
const HOOK_MARKER = 'claude-hook.js';

/**
 * Status lines belonging to other ad networks, matched case-insensitively as a
 * substring of the `statusLine` command — that value is a path or a shell line,
 * so it carries the vendor's package name in it.
 *
 * This list decides exactly one thing: whether our hook *executes* the displaced
 * command on every tick. Chaining is a courtesy we extend to a developer's own
 * HUD, and running another ad network's renderer from inside our render loop
 * would print their ad in the footer we are paid for. So a competitor's entry is
 * captured and restored like any other — it stays in `prev-statusline.json` and
 * `--remove` puts it back — but it is not run.
 *
 * Deliberately *not* used to skip the capture or to filter `spinnerVerbs`. Both
 * of those are deletions from a file the user owns, and `spinnerVerbs` in
 * particular is a shared array written once a tick from Claude's render loop: two
 * tools deleting each other's entries there rewrite `settings.json` several times
 * a second for as long as Claude is open, which is the write-war this module was
 * built to end (see the header). Taking the slot is decisive on its own — there
 * is only one of it.
 */
const COMPETITOR_MARKERS: readonly string[] = ['kickbacks', 'vibe-ads'];

/** Whether `command` is another ad network's status-line renderer. */
function isCompetitorCommand(command: string): boolean {
  const lowered = command.toLowerCase();
  return COMPETITOR_MARKERS.some((marker) => lowered.includes(marker));
}

/** {@link isCompetitorCommand}, applied to a raw `statusLine` value. */
function isCompetitorStatusLine(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const command = (value as { command?: unknown }).command;
  return typeof command === 'string' && isCompetitorCommand(command);
}

interface ClaudeStatusLine {
  type: 'command';
  command: string;
  padding: number;
}

/**
 * The `spinnerVerbs` value we write — wider than Claude's own schema on both
 * fields, and deliberately so, because every write to this key is a merge into
 * whatever another tool has already put there.
 *
 * `mode` is carried over from the file rather than forced back to `replace`:
 * another hook may have chosen it, and correcting someone else's setting on
 * every render is the write-war under a different name. `verbs` holds `unknown`
 * because the entries we merge around are not ours — a third-party verb, or
 * whatever a hand-edited file happens to contain, is passed through with its
 * type intact rather than normalised into ours.
 */
interface ClaudeSpinnerVerbs {
  mode: string;
  verbs: unknown[];
  [key: string]: unknown;
}

/**
 * A displaced `statusLine`, held as an open record rather than as
 * {@link ClaudeStatusLine}. We restore it verbatim, including any key we do not
 * model and any Claude adds later, so it is not ours to normalise.
 */
export type PreviousStatusLine = Record<string, unknown>;

/** The subset of `settings.json` we read; everything else is passed through. */
export interface ClaudeSettings {
  statusLine?: unknown;
  spinnerVerbs?: unknown;
  [key: string]: unknown;
}

/**
 * Install the native hook, and return the report lines to print. Never throws:
 * the native adapter is an enhancement, so anything that stops it is reported
 * and the surrounding alias install still stands on its own.
 *
 * `silent` returns no lines at all, for callers that run without the user having
 * asked for anything — {@link enforceNativeHook} repairs the install on every
 * `claude` launch, and a developer who typed `claude` did not ask for a report on
 * their settings file. It suppresses the *report*, not the work: the same edits
 * are made either way, so it must never be used to hide a failure the user needs
 * to act on. Every message this function returns is advisory or an
 * already-degraded no-op.
 */
export function installNativeHook(dryRun: boolean, silent = false): string[] {
  const report = (...lines: string[]): string[] => (silent ? [] : lines);

  const hookModule = resolveHookModule();
  if (hookModule === undefined) {
    return report(
      'Skipped the native Claude Code hook: the compiled hook is missing.',
      '  Run `pnpm build` in @airewards/cli-wrapper, then re-run `airewards setup`.',
    );
  }

  const settingsPath = claudeSettingsPath();
  if (!existsSync(claudeConfigDir())) {
    return report(
      `Skipped the native Claude Code hook: ${claudeConfigDir()} does not exist.`,
      '  Start Claude Code once, then re-run `airewards setup`.',
    );
  }

  const settings = readSettings(settingsPath);
  if (settings === undefined) {
    return report(
      `Skipped the native Claude Code hook: ${settingsPath} is not valid JSON.`,
      '  Fix or remove that file, then re-run `airewards setup`.',
    );
  }

  const chained = describeChainedStatusLine(settings.statusLine);
  const next = { ...settings, ...nativeSettings(settings) };

  if (dryRun) {
    return report(
      'Would install the native Claude Code hook:',
      `  ${HOOK_SCRIPT_FILE}`,
      `  ${settingsPath} (statusLine, spinnerVerbs)`,
      ...chained,
    );
  }

  writeHookLauncher(hookModule);
  capturePreviousStatusLine(settings.statusLine);
  backupOnce(settingsPath);
  writeSettings(settingsPath, next);

  return report(
    'Installed the native Claude Code hook, so Claude renders the ad itself:',
    `  ${HOOK_SCRIPT_FILE}`,
    `  ${settingsPath} (statusLine, spinnerVerbs)`,
    ...chained,
    'Restart Claude Code to pick it up.',
  );
}

/**
 * Put our `statusLine` back if something has taken it since setup ran, called
 * from `airewards run claude` immediately before Claude is spawned (see
 * `run.ts`). Claude reads `settings.json` at startup, so a repair landing here is
 * a repair that holds for the whole session.
 *
 * Three properties keep this safe to run on every launch:
 *
 * - **Repairs, never installs.** The gate is `~/.airewards/claude-hook.js`, which
 *   `--remove` deletes and only `airewards setup` writes. So a user who has
 *   uninstalled us stays uninstalled, and one who never opted in is never opted
 *   in by a stray `airewards run claude` — this must not become an install path
 *   that skips the reporting the real one does.
 * - **Idle when we already hold the slot**, which is the overwhelmingly common
 *   case. That path is one `existsSync` and one small read, both synchronous, so
 *   it does not measurably delay the spawn; a write happens only when the slot
 *   has actually been taken from us.
 * - **Never re-captures.** `prev-statusline.json` holds the status line the user
 *   had before AIRewards, recorded when they ran setup themselves. Overwriting it
 *   here would replace that baseline with whatever displaced us — losing the
 *   user's own HUD, silently, in a repair they never asked for. So a capture is
 *   only made when there is none.
 *
 * Silent and non-throwing throughout: this sits directly in front of the
 * developer's `claude`, and nothing about our footer is worth a stack trace or a
 * delay in front of their agent starting.
 */
export function enforceNativeHook(): void {
  try {
    // Not installed, or explicitly removed. Either way, not ours to restore.
    if (!existsSync(HOOK_SCRIPT_FILE)) return;

    const settingsPath = claudeSettingsPath();
    const settings = readSettings(settingsPath);
    // Unparseable settings are left alone here for the same reason `readSettings`
    // refuses to round-trip them: we would drop the user's comments.
    if (settings === undefined) return;

    // Still ours. `spinnerVerbs` is deliberately not checked — the hook patches
    // that key itself once a tick, so re-asserting it here would only add a write.
    if (ownsStatusLine(settings.statusLine)) return;

    if (!existsSync(PREV_STATUSLINE_FILE)) capturePreviousStatusLine(settings.statusLine);

    backupOnce(settingsPath);
    writeSettings(settingsPath, { ...settings, ...nativeSettings(settings) });
  } catch {
    // A settings file we cannot repair costs us a footer, not the developer
    // their command.
  }
}

/**
 * Remove the native hook, and return the report lines to print. Only keys that
 * are still recognisably ours are deleted, so a `statusLine` the user has since
 * repointed at their own script is left in place — and a `statusLine` we chained
 * is moved back into the slot we took it from.
 */
export function removeNativeHook(dryRun: boolean): string[] {
  const settingsPath = claudeSettingsPath();
  const settings = readSettings(settingsPath);

  const owned = settings !== undefined && ownsStatusLine(settings.statusLine);
  const ownedVerbs = settings !== undefined && ownsSpinnerVerbs(settings.spinnerVerbs);
  const installed = existsSync(HOOK_SCRIPT_FILE);
  const captured = existsSync(PREV_STATUSLINE_FILE);

  if (!owned && !ownedVerbs && !installed && !captured) {
    return ['No native Claude Code hook found; nothing to remove.'];
  }

  // Only restored into a slot that is still ours. If the user has since pointed
  // `statusLine` somewhere themselves, that is a newer decision than our capture.
  const restored = owned ? readPreviousStatusLine() : undefined;

  if (dryRun) {
    return [
      'Would remove the native Claude Code hook:',
      ...(installed ? [`  ${HOOK_SCRIPT_FILE}`] : []),
      ...(owned || ownedVerbs ? [`  ${settingsPath} (our keys only)`] : []),
      ...(restored === undefined ? [] : ['  Would restore the statusLine we chained.']),
    ];
  }

  if (settings !== undefined && (owned || ownedVerbs)) {
    backupOnce(settingsPath);
    writeSettings(settingsPath, withoutOurKeys(settings, owned, ownedVerbs, restored));
  }

  // The ad cache holds a tracking signature for an ad that will never be
  // rendered again, so it goes with the hook.
  remove(HOOK_SCRIPT_FILE);
  remove(AD_CACHE_FILE);
  remove(PREV_STATUSLINE_FILE);

  return [
    'Removed the native Claude Code hook.',
    ...(owned || ownedVerbs
      ? [
          `  Took our verbs and our statusLine out of ${settingsPath}; every other`,
          '  setting is untouched, including spinner verbs added by anything else.',
          ...describeRestore(restored !== undefined, captured),
        ]
      : []),
  ];
}

/**
 * What became of the status line we were standing in front of, which is the one
 * part of `--remove` a user with their own HUD has to be able to tell apart:
 *
 * - **Restored.** Their command is back in the slot; nothing more to do.
 * - **Captured, but the slot is no longer ours.** They repointed `statusLine`
 *   themselves after installing, so that newer decision stands and the capture is
 *   dropped — but it is worth saying so, since the copy we deleted was the only
 *   one besides the backup.
 * - **Nothing captured.** The slot was empty when we took it, so there is nothing
 *   to say at all. Mentioning the backup here would send them looking for a
 *   status line that never existed.
 */
function describeRestore(restored: boolean, captured: boolean): string[] {
  if (restored) return ['  Put your own statusLine back in the slot we borrowed.'];
  if (!captured) return [];
  return [
    '  Left the statusLine you have since set yourself in place; the one we',
    `  chained is still in ${basename(`${claudeSettingsPath()}.airewards.bak`)} beside it.`,
  ];
}

/**
 * `settings` with our keys taken back out, rebuilt key by key rather than by
 * deletion so the surviving settings keep both their values and their position
 * in the file.
 *
 * A chained `statusLine` is restored into the slot it was captured from, for the
 * same reason: the point of the chain is that the user's file ends up looking as
 * though we had never been in it.
 *
 * `spinnerVerbs` is the shared one, so it is unwound rather than deleted: our
 * verbs come out of the array and anything else stays, key and all. Only an array
 * that is empty once ours are gone takes the whole key with it — that is the state
 * we found it in, since a key holding nothing but our verbs is one we created.
 */
function withoutOurKeys(
  settings: ClaudeSettings,
  owned: boolean,
  ownedVerbs: boolean,
  restored: PreviousStatusLine | undefined,
): ClaudeSettings {
  const next: ClaudeSettings = {};

  for (const [key, value] of Object.entries(settings)) {
    if (key === 'statusLine' && owned) {
      if (restored !== undefined) next.statusLine = restored;
      continue;
    }
    if (key === 'spinnerVerbs' && ownedVerbs) {
      const kept = (currentVerbs(value) ?? []).filter((verb) => !isSponsoredVerb(verb));
      if (kept.length > 0) next.spinnerVerbs = withVerbs(value, kept);
      continue;
    }
    next[key] = value;
  }

  return next;
}

/**
 * The two keys we own, in the shape Claude Code's settings schema expects.
 *
 * `spinnerVerbs` is merged from what `settings` already holds for the same reason
 * the hook merges (see {@link mergeSponsoredVerb}): install is a write to a
 * shared array too, and seeding it by replacement would delete another tool's
 * verb at the one moment the user is least likely to connect the loss to us.
 * A `verbs` we cannot merge is replaced, since that is the state setup exists to
 * establish.
 */
function nativeSettings(settings: ClaudeSettings): {
  statusLine: ClaudeStatusLine;
  spinnerVerbs: ClaudeSpinnerVerbs;
} {
  const verbs = mergeSponsoredVerb(currentVerbs(settings.spinnerVerbs) ?? [], FALLBACK_VERB);

  return {
    spinnerVerbs: withVerbs(settings.spinnerVerbs, verbs),
    statusLine: {
      type: 'command',
      // An absolute path, not `~/…`: whether Claude runs this through a shell is
      // its business, and only an absolute path is correct either way.
      command: `node ${quoteForShell(HOOK_SCRIPT_FILE)}`,
      padding: 0,
    },
  };
}

/**
 * Write the launcher that `statusLine` invokes.
 *
 * A dynamic `import()` rather than a static one so the file is valid under
 * either module system — `~/.airewards` has no `package.json`, so Node's
 * interpretation of a bare `.js` depends on what it finds walking up from there.
 * The rejection is swallowed for the same reason the hook itself is silent: if
 * the package has been uninstalled, the developer gets no status line rather
 * than a stack trace redrawn on every frame.
 */
function writeHookLauncher(hookModule: string): void {
  const source = [
    '// Managed by `airewards setup`. Re-run it after reinstalling the package.',
    `import(${JSON.stringify(pathToImportUrl(hookModule))}).catch(() => {});`,
    '',
  ].join('\n');

  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(HOOK_SCRIPT_FILE, source, 'utf8');
}

/**
 * Absolute path of the compiled hook next to this module, or undefined when it
 * is not there — which means the package was not built, and pointing Claude at
 * a missing file would put an error in its footer.
 */
function resolveHookModule(): string | undefined {
  const path = fileURLToPath(new URL('./claude-hook.js', import.meta.url));
  return existsSync(path) ? path : undefined;
}

/**
 * A `file:` URL for `import()`. Passing a Windows path or one containing a `#`
 * or `?` as a plain specifier would be resolved as a relative path or truncated
 * at the fragment.
 */
function pathToImportUrl(path: string): string {
  return new URL(`file://${path.split('\\').join('/')}`).href;
}

/**
 * Claude Code's config directory, honouring `CLAUDE_CONFIG_DIR` — dotfile
 * managers and multi-account setups both use it, and writing to `~/.claude`
 * regardless would report success against a file Claude never reads.
 */
function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override !== undefined && override.length > 0 ? override : join(homedir(), '.claude');
}

/**
 * Path of the `settings.json` this package edits — exported so the status-line
 * hook resolves it the same way setup did, including the `CLAUDE_CONFIG_DIR`
 * override. A hook that guessed `~/.claude` independently would patch verbs into
 * a file Claude is not reading.
 */
export function claudeSettingsPath(): string {
  return join(claudeConfigDir(), 'settings.json');
}

/**
 * Parse `settings.json`, or undefined when it exists but cannot be read as a
 * JSON object. A missing file is an empty object: Claude creates it lazily, and
 * writing our two keys into a fresh one is exactly what it would have done.
 *
 * An unparseable file is deliberately *not* repaired or rewritten. Claude Code
 * tolerates comments in this file, and the only way to write back something we
 * parsed with `JSON.parse` would be to drop them — so a file we cannot round-trip
 * losslessly is a file we leave alone.
 */
export function readSettings(path: string): ClaudeSettings | undefined {
  if (!existsSync(path)) return {};

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }

  // An empty or whitespace-only file is a legitimate "no settings yet" state
  // that `JSON.parse` rejects.
  if (raw.trim().length === 0) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as ClaudeSettings;
  } catch {
    return undefined;
  }
}

/**
 * Serialise `settings` over `path` atomically.
 *
 * The write goes to a sibling temp file and is renamed into place, because this
 * is a file the user owns and Claude re-reads on its own schedule: a truncated
 * `settings.json` would cost them their models, permissions and hooks, not just
 * our two keys. The rename also makes the update safe against the status-line
 * hook, which patches the same file from a process that can overlap the previous
 * tick — a reader sees either the whole old file or the whole new one.
 *
 * The existing file's mode is carried over rather than left to the umask, so
 * patching a setting never quietly widens or narrows access to it.
 */
export function writeSettings(path: string, settings: ClaudeSettings): void {
  mkdirSync(dirname(path), { recursive: true });

  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: fileMode(path) });
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Never written, or already gone.
    }
    throw error;
  }
}

/** Permissions of an existing file, or the default for a new one. */
function fileMode(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return 0o644;
  }
}

/**
 * Merge the current ad into `spinnerVerbs`, so the copy Claude cycles through
 * while it thinks is the same copy in its footer. Called from the status-line
 * hook once a tick, after the chained status line has exited — see
 * `claude-hook.ts`.
 *
 * Four properties matter more than the update itself:
 *
 * - **Cooperative.** Only our own verbs are touched. Another tool's verb is read
 *   back out of the file and written straight through
 *   ({@link mergeSponsoredVerb}), so two hooks patching this key end up with a
 *   verb each instead of overwriting each other every frame.
 * - **Only while the slot is ours.** The gate is `statusLine`, not the verb
 *   array: this function only runs at all because Claude is executing our hook,
 *   and `--remove` takes that entry out. Gating on our own verb instead would
 *   mean a competing tool that replaced the array could permanently evict us —
 *   losing the write-war by forfeit — while a user who wants us gone still gets
 *   us gone, because `--remove` clears the thing being checked.
 * - **Silent.** This runs inside Claude's render loop, where the only channel to
 *   the user is their editor's footer. Every failure — unparseable settings, a
 *   read-only home directory — costs a spinner verb and nothing else.
 * - **Idle when unchanged.** The merged array is compared against the file's
 *   before anything is written, so the steady state — our ad already last, no
 *   stale copy to collapse — costs one read and no write, however often the tool
 *   we are chained to rewrites the same key.
 */
export function updateSpinnerVerbs(settingsPath: string, adText: string, adUrl: string): void {
  try {
    const settings = readSettings(settingsPath);
    if (settings === undefined) return;
    // Allow updating spinnerVerbs if we own statusLine or if our hook launcher exists (e.g. chained by another tool)
    if (!ownsStatusLine(settings.statusLine) && !existsSync(HOOK_SCRIPT_FILE)) return;

    const current = currentVerbs(settings.spinnerVerbs);
    if (current === undefined) return;

    const verbs = mergeSponsoredVerb(current, sponsoredVerb(adText, adUrl));
    if (sameVerbs(current, verbs)) return;

    backupOnce(settingsPath);
    writeSettings(settingsPath, {
      ...settings,
      spinnerVerbs: withVerbs(settings.spinnerVerbs, verbs),
    });
  } catch {
    // A settings file we cannot patch is not worth a stack trace in the footer.
  }
}

/** Whether `value` is a `statusLine` this package installed. */
function ownsStatusLine(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const command = (value as { command?: unknown }).command;
  return typeof command === 'string' && command.includes(HOOK_MARKER);
}

/**
 * Whether `value` is a `spinnerVerbs` holding a verb of ours — any verb carrying
 * our prefix, since the copy after it rotates with every ad.
 *
 * Note this asks less than it used to: the array can be *shared*, so a match here
 * means we have something in it, not that the key is ours to do as we like with.
 * `--remove` uses it to decide whether there is anything of ours to take out.
 */
function ownsSpinnerVerbs(value: unknown): boolean {
  return currentVerbs(value)?.some(isSponsoredVerb) === true;
}

/**
 * Announce what became of the status line we are standing in front of, which is
 * the one thing about the install a user with their own HUD needs told. The slot
 * itself cannot be shared, so the question is only whether we keep running what
 * was in it.
 *
 * Gated on the same predicate the capture uses, so the report cannot promise a
 * chain that {@link capturePreviousStatusLine} then declines to make.
 */
function describeChainedStatusLine(value: unknown): string[] {
  if (!isCapturable(value)) return [];

  if (isCompetitorStatusLine(value)) {
    return [
      '  Note: the statusLine already installed belongs to another ad network.',
      `  Saved to ${PREV_STATUSLINE_FILE} and restored by \`--remove\`, but not`,
      '  run from our hook — only one of us can bill for the same footer.',
    ];
  }

  return [
    '  Note: your existing statusLine is chained, not discarded.',
    `  Saved to ${PREV_STATUSLINE_FILE}; the hook runs it every tick and prints`,
    '  its output above the ad. `--remove` puts it back.',
  ];
}

/**
 * Whether `value` is a displaced `statusLine` worth keeping: someone else's, and
 * a JSON object of the shape Claude's schema uses. A string, an array, or a
 * `null` left in the slot is not something we could restore into it meaningfully.
 */
function isCapturable(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return !ownsStatusLine(value);
}

/**
 * Remember the `statusLine` we are about to displace, so the hook can keep
 * running it and `--remove` can put it back. Called only on the write path,
 * immediately before the settings are replaced.
 *
 * Three cases, and the difference between them is what keeps repeat installs
 * honest:
 *
 * - **Someone else's command.** Captured verbatim. A previous capture is
 *   overwritten, because the entry we are displacing *now* is the one we owe
 *   back.
 * - **Ours already.** Left alone: a re-run of `setup` must not capture our own
 *   command, which would make the chain point at itself.
 * - **Nothing there.** Any earlier capture is dropped. We are no longer standing
 *   in front of anything, so restoring one later would be resurrecting a status
 *   line the user has since removed themselves.
 */
function capturePreviousStatusLine(value: unknown): void {
  if (ownsStatusLine(value)) return;

  if (!isCapturable(value)) {
    remove(PREV_STATUSLINE_FILE);
    return;
  }

  try {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(PREV_STATUSLINE_FILE, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Failing to capture costs the chain, not the install — and the untouched
    // original is still in the `.airewards.bak` written just after this.
  }
}

/**
 * The displaced `statusLine` as it was captured, or undefined when there is
 * nothing to chain. Silent on every failure, because the hook calls this on
 * Claude's render loop.
 */
export function readPreviousStatusLine(): PreviousStatusLine | undefined {
  let raw: string;
  try {
    raw = readFileSync(PREV_STATUSLINE_FILE, 'utf8');
  } catch {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as PreviousStatusLine;
  } catch {
    return undefined;
  }
}

/**
 * The shell command of the chained status line, or undefined when there is
 * nothing to run. Lives here rather than in the hook so the one place that knows
 * how to recognise our own launcher is also the place that refuses to execute it:
 * a capture that somehow held our command would otherwise have every tick spawn
 * another tick.
 *
 * `type` is checked because `command` is the only kind of status line Claude
 * runs, and an entry of some future type is not a shell command just because it
 * happens to carry that field.
 */
export function chainedStatusLineCommand(): string | undefined {
  const previous = readPreviousStatusLine();
  if (previous === undefined) return undefined;
  if (previous.type !== undefined && previous.type !== 'command') return undefined;

  const command = previous.command;
  if (typeof command !== 'string' || command.trim().length === 0) return undefined;
  if (command.includes(HOOK_MARKER)) return undefined;
  // Another ad network's renderer. Captured and restorable like any other
  // displaced entry, but not run from our render loop — see
  // {@link COMPETITOR_MARKERS}.
  if (isCompetitorCommand(command)) return undefined;

  return command;
}

/**
 * Preserve the untouched original the first time we edit, matching the rc-file
 * backup in `setup.ts`. Written once only: a second run must not overwrite the
 * backup with an already-modified file.
 */
function backupOnce(path: string): void {
  if (!existsSync(path) || existsSync(`${path}.airewards.bak`)) return;
  copyFileSync(path, `${path}.airewards.bak`);
}

function remove(path: string): void {
  rmSync(path, { force: true });
}

/**
 * Quote a path for the `statusLine` command string if it needs it. Claude may
 * hand the command to a shell, and an unquoted home directory with a space in it
 * would arrive as two arguments.
 */
function quoteForShell(path: string): string {
  return /[\s"'\\$`]/.test(path) ? `"${path.split('"').join('\\"')}"` : path;
}
