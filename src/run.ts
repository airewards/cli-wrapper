/**
 * `airewards run <command> [args…]` — the universal terminal proxy.
 *
 * Spawns the target binary, relays it faithfully, and monetises the time it
 * spends thinking. The guiding rule is unchanged: the developer's command must
 * behave exactly as it would unwrapped, so if anything ad-related is missing,
 * slow, or broken, the proxy silently degrades to a plain relay.
 *
 * ## Stream topology
 *
 * There are two, and which one runs is decided per invocation.
 *
 * **Pseudo-terminal** — used when there is an ad to show:
 *
 * ```
 *   user tty ──stdin(raw)──▶ proxy ──▶ pty master ──▶ child (owns pty slave)
 *   user tty ◀── session  ◀── proxy ◀── pty master ◀──┘
 * ```
 *
 * The child is given a pty slave as its three descriptors, so from inside it
 * the world looks exactly like a terminal: `isTTY` is true, `TIOCGWINSZ`
 * returns a window size, raw mode works, and `^C` becomes a SIGINT via the pty's
 * own line discipline. But the master side is ours, so every byte it writes
 * passes through a {@link PtySession} on the way to the screen. That is what
 * makes a live ad possible at all — a plain `pipe` would report
 * `isTTY === false` and make interactive agents refuse to start, and
 * `stdio: 'inherit'` hands the terminal over with nothing left to intercept.
 *
 * The window size the child measures is ours to decide too, and under the
 * reserved-row strategy it is deliberately one row short of the truth — see "The
 * two pty strategies".
 *
 * **Inherited descriptors** — the fallback, and still the common path:
 *
 * ```
 *   user tty ◀──stdin/stdout/stderr (inherited fds)──▶ child
 * ```
 *
 * Byte-for-byte perfect, because this process is not in the stream at all. It
 * is used whenever a pty would be a downgrade or a risk: no ad to inject, the
 * native `node-pty` addon unavailable, stdin or stdout not a terminal, the
 * command not resolvable on PATH, or `AIREWARDS_PTY=0`. A pty is strictly more
 * machinery than a relay needs, so it is only paid for when it buys something.
 *
 * It is also the path taken by an agent that monetises itself natively. Claude
 * Code renders our ad in its own footer through the `statusLine` hook that
 * `airewards setup` installs, so there is nothing for the proxy to intercept and
 * nothing for it to print; it relays and stays out of the stream entirely. See
 * `claude-native.ts` and `claude-hook.ts`.
 *
 * ## The two pty strategies
 *
 * A pty makes interception possible; it does not settle which row the ad goes
 * on, and that choice is what decides whether an agent can be monetised at all.
 *
 * **The reserved row** (`reserved-row.ts`) is the default wherever the window
 * can spare a row. The pty is allocated one row shorter than the terminal, the
 * scrolling region is fenced above the row that leaves over, and the ad is
 * painted there for the whole session. It asks the child for nothing, which is
 * the entire point: `codex`, `cline` and every other agent built on absolute
 * positioning owns its screen and has no disposable row to lend, so there was
 * previously nothing to borrow and nothing to earn.
 *
 * **The borrowed status line** (`injector.ts`) is the fallback, for a window too
 * short to give a row away ({@link reservedRowViable}) or a developer who asked
 * for their full height back (`AIREWARDS_RESERVED_ROW=0`). It rewrites a row the
 * child parked its cursor on and hands it straight back, so it needs no space of
 * its own — and for the scrolling agents it was built around, it is not a
 * downgrade.
 *
 * Both are driven through {@link PtySession}, so {@link pumpPty} relays the
 * terminal without knowing which one it is running.
 *
 * ## Earn loop
 *
 * The ad is fetched before the spawn on every path, and both of the ways it can
 * be shown are downstream of that one request. Every failure path — no key, no
 * TTY, no ad, offline server — resolves to "no ad" and spawns immediately; the
 * request is hard-bounded by the client's own timeout so a dead ad server cannot
 * stall the command for more than that.
 *
 * Under a pty, nothing is printed before the spawn. An interactive agent takes
 * the terminal over with its own first frame — a full-height composer, a cleared
 * region, a redrawn header — so a static line above it is scrolled or painted out
 * of view before it can be read: a worse first impression than no ad at all, and
 * an impression credited against something nobody saw. The placement is still
 * fetched, because it is the copy both pty strategies paint.
 *
 * What earns under a pty is a dwell proved against the row the ad is on, never
 * against the clock alone, and each strategy has its own proof because each holds
 * its row on different terms. On the reserved row the ad cannot be overwritten,
 * so a dwell is broken only by the row ceasing to be ours — an editor taking the
 * alternate screen buffer, a resize moving the row — which {@link ReservedRow.epoch}
 * reports; one impression is credited per ad that survives it, and the copy is
 * rotated on {@link AD_ROTATION_MS} so there is a fresh signature to earn on.
 * On a borrowed status line the child reclaims the row with its next byte of
 * output, so the proof is {@link AdInjector.injectionId} still being current when
 * the timer fires — see "Prompt-triggered ads". A status line the injector
 * rewrites of its own accord carries the ad but starts no dwell of its own.
 *
 * On inherited descriptors the placement is printed as a static banner above the
 * child's first byte of output, and a 5s dwell timer starts with it: if the
 * command is still running when it fires, one impression is posted in the
 * background. A command that finishes sooner is never credited — the ad was not
 * visible long enough. That path is reached *with an ad in hand* only when the
 * terminal is real but interception is not available — `AIREWARDS_PTY=0`, no
 * `node-pty`, no pty to allocate, a command that is not on PATH — and this
 * process is not in the stream once the child is running, so a line above the
 * command is the only ad it can show at all.
 *
 * The native path has its own equivalent loop inside the hook, since there is no
 * long-lived process there to hold a timer.
 *
 * ## Prompt-triggered ads
 *
 * Belongs to the borrowed-status-line strategy alone, and exists because of that
 * strategy's one blind spot. The injector can only rewrite a status line an agent
 * actually paints, and the interesting ones often paint nothing: they clear their
 * own region and sit silent for the ten or twenty seconds the model takes. That
 * silence is the most valuable inventory the proxy has and the output stream gives
 * no way to notice it, so this path watches the *input* stream too, where the same
 * moment is unmistakable — the user pressed Enter.
 *
 * The reserved row needs none of it: its ad went up with the fence and is on
 * screen whether or not the child ever paints anything.
 *
 * On Enter the proxy fetches a fresh ad and hands it to
 * {@link AdInjector.inject}, which borrows the row the child parked its cursor
 * on. Nothing about this blocks the keystroke: the child is written first and
 * the fetch runs behind it, so the agent starts working on the prompt at exactly
 * the moment it would have unwrapped.
 *
 * Three things make it safe to do on every submission:
 *
 * - **A fresh ad, never the pre-spawn one.** An ad's tracking signature is
 *   single-use and expires in five minutes, so re-showing the placement fetched
 *   before the spawn — the copy the injector's output path already holds — would
 *   be an ad that cannot be credited. Each submission gets its own.
 * - **A cooldown.** Enter is an ambiguous signal — it also confirms a dialog and
 *   inserts a newline in a multi-line composer — so
 *   {@link PROMPT_AD_COOLDOWN_MS} is what keeps a burst of keystrokes from
 *   becoming a burst of requests.
 * - **Dwell proved against the row, not the clock.** The ad lives on a row the
 *   child owns and reclaims with its next byte of output, which for a fast reply
 *   is well inside the 5s dwell. So the impression is credited only if the
 *   injection is *still the one on screen* when the timer fires — see
 *   {@link AdInjector.injectionId}. An ad the agent wiped after 200ms earns
 *   nothing, which is the same 5s of visible ad the banner path is paid for.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { hyperlink } from './ansi.js';
import { type Ad, AdClient, IMPRESSION_DELAY_MS } from './api.js';
import { enforceNativeHook, usesNativeAdapter } from './claude-native.js';
import { loadConfig } from './config.js';
import { type AdInjector, createAdInjector } from './injector.js';
import { findExecutable } from './path.js';
import { type PtyProcess, loadPty } from './pty.js';
import {
  type ReservedRow,
  childRows,
  createReservedRow,
  reservedRowViable,
} from './reserved-row.js';

/** Exit codes POSIX shells use for "found but not executable" / "not found". */
const EXIT_NOT_EXECUTABLE = 126;
const EXIT_NOT_FOUND = 127;
/** Our own usage error; distinct from anything the child could return. */
const EXIT_USAGE = 2;

/**
 * Set on the child's environment so a nested `airewards run` (an aliased agent
 * that shells out to another aliased agent) relays without monetising a second
 * time on top of the outer proxy.
 */
const WRAPPED_ENV_VAR = 'AIREWARDS_WRAPPED';

/** Set to `0` to force the inherited-fd relay and skip the pty entirely. */
const PTY_ENV_VAR = 'AIREWARDS_PTY';

/**
 * Set to `0` to relay under the borrowed-status-line strategy even where the
 * window could spare a row.
 *
 * An escape hatch rather than a feature flag. The reserved row withholds a row
 * from the child for the whole session, which is the right trade for an agent
 * that would otherwise be unmonetisable — but it is still a row, and a developer
 * who wants their full window back should not have to stop using the proxy to
 * get it.
 */
const RESERVED_ROW_ENV_VAR = 'AIREWARDS_RESERVED_ROW';

/** Signals forwarded to the child instead of killing the proxy underneath it. */
const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

/**
 * How long the proxy will linger after the child exits so an already-earned
 * impression can land. Short on purpose: the developer's prompt coming back
 * matters more than one impression.
 */
const IMPRESSION_GRACE_MS = 2_000;

/**
 * Least time between two prompt-triggered ads.
 *
 * Enter does not only submit prompts — it dismisses agent dialogs, picks items
 * out of a menu, and inserts a newline in a multi-line composer — and the proxy
 * cannot tell those apart from outside the child. The cooldown is what makes
 * that acceptable: a misread keystroke costs at most one wasted fetch per
 * window, and a real submission during someone else's window simply goes
 * unmonetised. Set above the ad's own dwell time so a submission can never
 * displace the ad an earlier one is still earning on.
 */
const PROMPT_AD_COOLDOWN_MS = 8_000;

/** Carriage return (raw-mode Enter) and line feed, either of which submits. */
const SUBMIT_KEYS = new Set(['\r', '\n']);

/**
 * Start of a bracketed paste (`ESC [ 200 ~`), which terminals emit around
 * pasted text so an application can tell it from typing.
 */
const PASTE_START = '[200~';

/** Window size assumed when the terminal will not report one. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * How long after a burst of child output the reserved row is repainted.
 *
 * The row is ours and the child cannot address it, but it can still *scroll*
 * over it in the moments before the fence takes hold, and a terminal that was
 * resized or had its margins reset by something outside this process leaves the
 * row stale. Repainting after output settles costs one write per burst and makes
 * every one of those recoverable.
 *
 * Debounced rather than periodic: an agent streaming tokens emits dozens of
 * chunks a second, and a repaint per chunk would be dozens of redundant writes
 * competing with the frame the child is drawing.
 */
const RESERVED_ROW_REPAINT_MS = 150;

/**
 * How often the reserved row takes a fresh ad.
 *
 * Also the impression cadence, and the two cannot be separated: a tracking
 * signature is single-use, so the row can be credited exactly once per ad it is
 * given. A rotation is therefore what makes the *next* impression possible, and
 * one is credited per rotation once the ad has held the row for
 * {@link IMPRESSION_DELAY_MS}.
 */
const AD_ROTATION_MS = 60_000;

const CYAN = '\u001B[36m';
const RESET = '\u001B[0m';

/**
 * Run `argv` as `[command, ...args]` and resolve with the exit code the proxy
 * should adopt. Never rejects.
 */
export async function runCommand(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined || command.length === 0) {
    process.stderr.write('airewards: usage: airewards run <command> [args…]\n');
    return EXIT_USAGE;
  }

  // Claude Code is monetised from the inside by the native `statusLine` hook
  // (see `claude-native.ts`), so the proxy has nothing left to do for it and
  // gets out of the way completely: no pty, no injection, and no banner either,
  // since the footer is already carrying an ad whose impression is credited by
  // the hook. Relaying on inherited descriptors makes this process invisible.
  //
  // The one thing done first is repairing that hook if it has been displaced
  // since setup ran. Claude reads `settings.json` at startup, so this is the
  // last moment a repair still counts for the session about to begin, and it
  // only repairs an install that already exists — see `enforceNativeHook`.
  // Synchronous, and a no-op beyond two small reads whenever the slot is still
  // ours, so it does not delay the spawn.
  if (usesNativeAdapter(command)) {
    enforceNativeHook();
    return runInherited(command, args);
  }

  // Fetched before the spawn on every path, so whichever strategy runs has an ad
  // in hand from the child's first frame. Whether it is *printed* is decided by
  // the topology — see `relay`.
  const placement = await fetchPlacement();
  return relay(command, args, placement);
}

/**
 * Run the child under the strongest topology this invocation can support, and
 * resolve with the exit code to adopt.
 *
 * The choice of topology is also the choice of how the ad is shown. A pty means
 * the child can be intercepted, so the ad lives on a row of the screen — one
 * reserved from the child where the window can spare it, one borrowed from the
 * child where it cannot — and nothing is printed at startup. Inherited
 * descriptors mean it cannot be touched at all, so the static banner is the only
 * inventory there is.
 */
async function relay(
  command: string,
  args: string[],
  placement: AdPlacement | undefined,
): Promise<number> {
  if (placement !== undefined && ptyEligible()) {
    const rows = process.stdout.rows ?? DEFAULT_ROWS;
    const columns = process.stdout.columns ?? DEFAULT_COLS;
    const reserving = reservedRowEnabled() && reservedRowViable(rows);

    // The row is withheld at the pty, before the child's first `TIOCGWINSZ`:
    // the lie has to be in place from its very first frame, since an agent that
    // measured the window once will position against that height forever.
    const child = spawnPty(command, args, columns, reserving ? childRows(rows) : rows);
    // Anything that stopped the pty from starting — no addon, unresolvable
    // command, `openpty` refused — falls through to the relay that has always
    // worked, including its command-not-found diagnostics, and to the banner
    // that is the only ad that path can carry.
    if (child !== undefined) {
      const session = reserving
        ? reservedRowSession(placement, columns, rows)
        : borrowedRowSession(placement, columns);
      return pumpPty(child, session);
    }
  }

  if (placement === undefined) return runInherited(command, args);
  return runBannered(command, args, placement);
}

/**
 * Print `placement` above the child, relay on inherited descriptors, and credit
 * the impression if the banner held the screen for the dwell time.
 *
 * The banner is deliberately confined to this path. Nothing here can be
 * intercepted once the child is spawned — this process is not in the stream —
 * so a static line above its first byte of output is the whole of the earn loop,
 * and it is what monetises the non-interactive commands (`build`, `test`,
 * `sleep`) that never paint a status line to borrow. An interactive agent under
 * a pty gets the opposite treatment for the same reason: it *can* be
 * intercepted, and it would scroll this line out of view on its first frame.
 */
async function runBannered(
  command: string,
  args: string[],
  placement: AdPlacement,
): Promise<number> {
  // Printed before the spawn so it sits above the child's first line of output.
  process.stdout.write(banner(placement.ad));

  const earnLoop = startEarnLoop(placement);
  try {
    return await runInherited(command, args);
  } finally {
    await earnLoop.finish();
  }
}

/**
 * Whether a pty is worth attempting, independent of whether the addon loads.
 *
 * Both ends have to be real terminals: stdout because the injector writes
 * cursor control to it, and stdin because the pty takes over echo and line
 * editing, which requires putting our own descriptor into raw mode. A piped
 * stdin (`echo … | claude -p`) or a redirected stdout is relayed instead, which
 * also keeps non-interactive output byte-identical to the bare command.
 */
function ptyEligible(): boolean {
  return (
    process.env[PTY_ENV_VAR] !== '0' &&
    process.stdout.isTTY === true &&
    process.stdin.isTTY === true
  );
}

/**
 * Whether the reserved-row strategy may be used at all, independent of whether
 * this particular window is tall enough for it ({@link reservedRowViable}).
 */
function reservedRowEnabled(): boolean {
  return process.env[RESERVED_ROW_ENV_VAR] !== '0';
}

/**
 * Start `command` on a pty `columns`×`rows`, or undefined when that is not
 * possible.
 *
 * `rows` is the height the *child* is told the window has, which under the
 * reserved-row strategy is one short of the real one. Passing it here rather
 * than reading the terminal directly is what makes the lie total: node-pty
 * answers every `TIOCGWINSZ` from the size it was given, so the child never sees
 * the row we kept, not even in the window size it measures at startup.
 *
 * The binary is resolved off PATH here rather than left to the addon because a
 * pty child that fails to `exec` reports it as ordinary output on the terminal
 * plus a generic exit code — there is no `error` event to translate into the
 * conventional 127/126. Resolving first keeps those diagnostics with the
 * inherited-fd path, which already gets them right.
 */
function spawnPty(
  command: string,
  args: string[],
  columns: number,
  rows: number,
): PtyProcess | undefined {
  const pty = loadPty();
  if (pty === undefined) return undefined;

  const executable = findExecutable(command);
  if (executable === undefined) return undefined;

  try {
    return pty.spawn(executable, args, {
      name: process.env.TERM ?? 'xterm-256color',
      cols: columns,
      rows,
      cwd: process.cwd(),
      env: ptyEnv(),
    });
  } catch {
    // A pty could not be allocated (exhausted pty devices, a sandbox that
    // forbids them). Not the developer's problem.
    return undefined;
  }
}

/**
 * One interception strategy, as the pty pump sees it.
 *
 * Both strategies weave an ad into the same stream and differ only in which row
 * they write to, so the pump is written against this and knows nothing about
 * either. What it does know is that the strategy may need to write to the
 * terminal at moments the pump is not involved in — a rotation timer, a repaint
 * after a burst — so a session is handed the sink at construction and the pump
 * only routes what passes through it.
 */
interface PtySession {
  /** Bytes to write before the child's first output: the fence, or nothing. */
  start(): string;
  /** Map one chunk of child output to the bytes that should reach the terminal. */
  transform(chunk: string): string;
  /** The user submitted something to the child. */
  onSubmit(): void;
  /**
   * Adopt a new window size and return the size the *child* should be told
   * about, plus any bytes the terminal needs.
   */
  resize(columns: number, rows: number): { readonly rows: number; readonly bytes: string };
  /** Bytes that leave the terminal clean once the child has exited. */
  finish(): string;
  /** Drop every timer and in-flight request; the session is over. */
  stop(): Promise<void> | void;
}

/**
 * The borrowed-status-line strategy: `injector.ts` plus the prompt-triggered
 * ads that share its row. Used when the window has no row to spare, and for the
 * scrolling agents the injector was built around.
 */
function borrowedRowSession(placement: AdPlacement, columns: number): PtySession {
  const injector = createAdInjector(placement.ad, columns);
  const prompts = startPromptAds(injector, placement.client);

  return {
    start: () => '',
    transform: (chunk) => injector.transform(chunk),
    onSubmit: () => prompts.onSubmit(),
    // The child is given the whole window here, so a resize is nothing but a
    // resize; the injector reads no geometry it needs told about.
    resize: (_columns, rows) => ({ rows, bytes: '' }),
    finish: () => injector.flush(),
    stop: () => prompts.stop(),
  };
}

/**
 * The reserved-row strategy: a row withheld from the child, an ad painted on it,
 * and an impression per ad that holds it for the dwell time.
 *
 * The three timers are all consequences of the row being *ours*. Nothing the
 * child does can take the ad down, so there is no injection to race and no
 * status line to wait for — but equally nothing redraws the ad for us, so the
 * repaint is debounced behind the child's output bursts, and the copy has to be
 * rotated for there to be a second impression to earn at all.
 */
function reservedRowSession(placement: AdPlacement, columns: number, rows: number): PtySession {
  const row = createReservedRow(columns, rows);
  const earn = startReservedRowEarnLoop(row, placement);

  return {
    start(): string {
      // The fence first, then the ad: the child has written nothing yet, so this
      // is the one moment the margins can be set without a frame in flight.
      return row.fence() + earn.paint();
    },

    transform(chunk: string): string {
      const out = row.transform(chunk);
      earn.touched();
      if (row.needsRepaint()) {
        return out + earn.paint();
      }
      return out;
    },

    // Nothing to do: the row is not shared with the child, so a submission is
    // not the opportunity it is for the borrowed-row strategy — the ad is
    // already on screen and has been since the fence went up.
    onSubmit: () => {},

    resize(nextColumns: number, nextRows: number) {
      return { rows: childRows(nextRows), bytes: row.resize(nextColumns, nextRows) + earn.paint() };
    },

    finish: () => row.flush(),
    stop: () => earn.stop(),
  };
}

/**
 * Relay the terminal to and from `child` under `session`, and resolve with the
 * exit code to adopt.
 */
function pumpPty(child: PtyProcess, session: PtySession): Promise<number> {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;

  // Raw mode hands keystrokes over untouched, so echo, line editing and
  // ^C → SIGINT are all resolved by the pty's line discipline, exactly as they
  // would be if the child held the terminal itself. Leaving our own descriptor
  // cooked would double-echo every keystroke and swallow Ctrl-C.
  stdin.setRawMode(true);
  stdin.resume();

  // A decoder rather than a plain `toString`: a multi-byte character (or an
  // emoji in a pasted prompt) can straddle two reads, and half a code point
  // written to the child is a corrupted keystroke.
  const decoder = new StringDecoder('utf8');
  const onInput = (data: Buffer): void => {
    const keys = decoder.write(data);
    // The keystroke reaches the child before anything ad-related is considered,
    // so a submission starts the agent working at exactly the moment it would
    // have unwrapped.
    child.write(keys);
    if (submitted(keys)) session.onSubmit();
  };
  const onResize = (): void => {
    const columns = process.stdout.columns ?? DEFAULT_COLS;
    const rows = process.stdout.rows ?? DEFAULT_ROWS;
    const next = session.resize(columns, rows);
    // The child is resized first: the strategy's bytes describe the window it is
    // about to measure, and a fence issued against the old height would be
    // overwritten by the SIGWINCH handling that follows it.
    child.resize(columns, next.rows);
    if (next.bytes.length > 0) process.stdout.write(next.bytes);
  };

  let running = true;
  const releaseSignals = forwardSignals((signal) => {
    if (running) child.kill(signal);
  });

  stdin.on('data', onInput);
  process.stdout.on('resize', onResize);

  // Before the child's first byte, so the margins the fence sets are in force
  // for every frame it draws.
  const opening = session.start();
  if (opening.length > 0) process.stdout.write(opening);

  return new Promise<number>((resolve) => {
    child.onData((chunk) => process.stdout.write(session.transform(chunk)));

    // node-pty defers this until the master socket has closed, so all of the
    // child's output has already been through the session by now.
    child.onExit(async ({ exitCode, signal }) => {
      running = false;

      // Before `releaseSignals`, so a prompt ad fetched moments before the exit
      // cannot hold the event loop open past the shell prompt coming back — and
      // before the cleanup below, so no timer can repaint over it.
      await session.stop();

      // Take the sponsored row down and give the whole screen back before
      // handing the terminal over, so the shell prompt does not draw on top of
      // an ad or inside a scrolling region it did not set.
      process.stdout.write(session.finish());

      releaseSignals();
      stdin.off('data', onInput);
      process.stdout.off('resize', onResize);
      stdin.setRawMode(wasRaw);
      // Without this the still-flowing stdin keeps the event loop alive and the
      // shell prompt never comes back.
      stdin.pause();

      // Mirror the shell convention so `$?` matches an unwrapped run.
      resolve(signal !== undefined && signal !== 0 ? 128 + signal : exitCode);
    });
  });
}

/**
 * Relay `command` on this process's own descriptors and resolve with its exit
 * code. Nothing of its output passes through us.
 */
function runInherited(command: string, args: string[]): Promise<number> {
  // `shell: false` (the default) is deliberate: the command is resolved
  // straight off PATH by execvp, so user arguments are never re-parsed by a
  // shell, and the `alias claude="airewards run claude"` we install cannot
  // recurse (aliases only expand in interactive shell input).
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: childEnv(),
  });

  const releaseSignals = forwardSignals((signal) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });

  return waitForExit(child, command).finally(releaseSignals);
}

/** An ad to show, paired with the client that can credit its impression. */
interface AdPlacement {
  readonly ad: Ad;
  readonly client: AdClient;
}

/**
 * Resolve the ad this invocation will show — as a banner on the inherited-fd
 * path, as the copy on the reserved or borrowed row under a pty — or undefined
 * when there is nothing to show. Never rejects: every failure is a no-op by
 * design — no key, no TTY, no ad, offline server. None of them may surface to the
 * developer.
 */
async function fetchPlacement(): Promise<AdPlacement | undefined> {
  const config = loadConfig();

  const eligible =
    config.apiKey !== undefined &&
    // A non-TTY run must stay byte-identical to the bare command, so nothing is
    // printed and there is no impression to credit.
    process.stdout.isTTY === true &&
    // An outer proxy is already monetising this command tree.
    process.env[WRAPPED_ENV_VAR] !== '1';

  if (!eligible || config.apiKey === undefined) return undefined;

  const client = new AdClient(config.baseUrl, config.apiKey);
  try {
    const ad = await client.fetchCurrentAd();
    return ad === null ? undefined : { ad, client };
  } catch {
    return undefined;
  }
}

/**
 * One static line plus a blank one, so the child's first output never appears
 * welded to the ad.
 *
 * The copy is an OSC 8 hyperlink, so a terminal that supports them makes it
 * clickable; the URL is *also* printed in plain text after it, which is what
 * the developer is left with everywhere else. That redundancy is the point —
 * there is no way to ask a terminal whether it honours OSC 8, so the line has
 * to read correctly whether or not the link renders. Terminals that do not
 * support it discard the sequence and see exactly the line we printed before
 * this change; the rare one that prints the escape raw still shows a followable
 * URL at the end.
 */
function banner(ad: Ad): string {
  const copy = `✨ [Sponsored] ${ad.text}`;
  const link = hyperlink(ad.url, copy);
  // `hyperlink` returns the copy untouched when the URL is not linkable, which
  // is also when there is nothing worth printing after it.
  const suffix = link === copy ? '' : ` | ${ad.url}`;
  return `${CYAN}${link}${suffix}${RESET}\n\n`;
}

/**
 * Resolve once the child has exited *and* its stdio has been flushed
 * (`close`, not `exit`) so no trailing output is lost behind our exit.
 */
function waitForExit(child: ChildProcess, command: string): Promise<number> {
  return new Promise((resolve) => {
    child.on('error', (error: NodeJS.ErrnoException) => {
      // Spawn itself failed: report it the way a shell would, with the matching
      // conventional exit code. The errno is not trustworthy for this —
      // a PATH search that ends in an unreadable directory surfaces as EACCES
      // even when the command simply does not exist — so inspect the filesystem
      // ourselves to tell "missing" apart from "not executable".
      const missing = findExecutable(command) === undefined;
      if (missing && !existsSync(command)) {
        process.stderr.write(`airewards: command not found: ${command}\n`);
        resolve(EXIT_NOT_FOUND);
        return;
      }
      process.stderr.write(
        missing
          ? `airewards: permission denied: ${command}\n`
          : `airewards: cannot execute ${command}: ${error.message}\n`,
      );
      resolve(EXIT_NOT_EXECUTABLE);
    });

    child.on('close', (code, signal) => {
      // Mirror the shell convention so `$?` matches an unwrapped run.
      resolve(signal ? 128 + signalNumber(signal) : (code ?? 0));
    });
  });
}

/**
 * Relay terminating signals to the child rather than dying first, and keep the
 * proxy alive until the child's own exit determines our code.
 *
 * Mostly a backstop: the child shares our foreground process group either way,
 * so an interactive Ctrl-C already reaches it — under a pty via the line
 * discipline, under inherited descriptors directly. Forwarding covers the cases
 * where it does not (`kill` sent to the wrapper's pid alone).
 */
function forwardSignals(kill: (signal: NodeJS.Signals) => void): () => void {
  const handlers = FORWARDED_SIGNALS.map((signal) => {
    const handler = (): void => kill(signal);
    process.on(signal, handler);
    return { signal, handler };
  });

  return () => {
    for (const { signal, handler } of handlers) process.off(signal, handler);
  };
}

interface EarnLoop {
  /**
   * Wind the loop down: cancel an unearned impression, and give an
   * already-earned one a brief chance to land.
   */
  finish(): Promise<void>;
}

/**
 * Credit the developer if `placement`'s banner stays on screen for the dwell
 * time. Fire-and-forget: the returned handle only winds down.
 *
 * Belongs to the banner, so only the inherited-fd path starts one. Under a pty
 * the ad lives on a row whose visibility this process can actually observe, so
 * what earns there is a dwell proved against the row rather than against the
 * clock — see {@link startReservedRowEarnLoop} and {@link startPromptAds}.
 *
 * The dwell timer is cleared by {@link EarnLoop.finish} the moment the child
 * closes, so it firing *is* the proof that the command was still running — the
 * "5 seconds of visible ad" the impression is paid for.
 */
function startEarnLoop(placement: AdPlacement): EarnLoop {
  const { ad, client } = placement;
  const viewedAt = new Date();
  let impression: Promise<void> | undefined;
  let active = true;

  const dwellTimer = setTimeout(() => {
    impression = client
      .recordImpression(ad, viewedAt, IMPRESSION_DELAY_MS, () => active)
      .catch(() => {});
  }, IMPRESSION_DELAY_MS);

  return {
    async finish(): Promise<void> {
      active = false;
      clearTimeout(dwellTimer);

      if (impression === undefined) return;
      // Let an earned impression land, but never make the developer wait on it.
      await Promise.race([impression, delay(IMPRESSION_GRACE_MS)]);
    },
  };
}

/** The reserved-row side of the earn loop. See "The reserved row" above. */
interface ReservedRowEarnLoop {
  /**
   * Bytes that put the current ad on the reserved row, and start (or continue)
   * the dwell it will be credited for. Empty while painting is valved off.
   */
  paint(): string;
  /** The child wrote something: schedule a repaint once the burst settles. */
  touched(): void;
  /** Drop every timer and abandon an in-flight fetch. */
  stop(): Promise<void>;
}

/**
 * Keep an ad on the reserved row and credit one impression per ad that holds it
 * for the dwell time.
 *
 * The row is ours, so what earns here is much simpler than on a borrowed one:
 * there is no injection for the child to overwrite and no status line to wait
 * for. Two things can still take the ad off the screen, and {@link ReservedRow.epoch}
 * reports both — the child taking the alternate screen buffer, and a resize
 * moving the row out from under what was painted on it. An unchanged epoch
 * across the dwell window is the proof the impression is paid for, and it is
 * proof of the same thing the banner's timer proves: five seconds of ad the
 * developer could actually see.
 *
 * The rotation is what makes a *second* impression possible. A tracking
 * signature is single-use, so the row can be credited once for the copy it is
 * holding; fresh copy every {@link AD_ROTATION_MS} is both a new thing to look
 * at and the only way the session goes on earning.
 */
function startReservedRowEarnLoop(row: ReservedRow, placement: AdPlacement): ReservedRowEarnLoop {
  const { client } = placement;
  /** Bounds every request to the session, so the exit path can drop them all. */
  const abort = new AbortController();
  let ad = placement.ad;
  /** True once `ad` has earned its one impression; reset by a rotation. */
  let credited = false;
  let stopped = false;
  /** The epoch the pending dwell was armed under; see {@link armDwell}. */
  let dwellEpoch = -1;
  let dwellTimer: NodeJS.Timeout | undefined;
  let repaintTimer: NodeJS.Timeout | undefined;
  let pendingImpression: Promise<void> | undefined;

  /**
   * Start the dwell for the ad now on the row, unless one is already running
   * against an unbroken epoch.
   *
   * Restarting it on every repaint would mean an agent that streams output for a
   * minute never credits anything, since a repaint lands every ~150ms of it. But
   * a repaint *after* the epoch moved is a genuinely new showing — the ad was off
   * the screen and is back — and that one has to start its dwell over, because
   * the seconds before it were not seconds anybody saw the ad for.
   */
  let lastRepaintAt = Date.now();
  const MAX_REPAINT_GAP_MS = 500;

  const armDwell = (): void => {
    if (credited || stopped) return;
    if (dwellTimer !== undefined && dwellEpoch === row.epoch()) return;

    clearTimeout(dwellTimer);
    dwellEpoch = row.epoch();
    dwellTimer = setTimeout(() => {
      dwellTimer = undefined;
      // The row was taken over (an editor launched, the window was resized) at
      // some point in the window, so these five seconds were not five seconds of
      // visible ad. The next repaint arms a fresh dwell.
      if (row.epoch() !== dwellEpoch || row.suspended() || stopped) return;

      credited = true;
      // Dated backwards from now: the dwell that just elapsed is the window the
      // developer is paid for.
      const viewedAt = new Date(Date.now() - IMPRESSION_DELAY_MS);
      const earned = ad;
      const earnedEpoch = dwellEpoch;
      pendingImpression = client
        .recordImpression(
          earned,
          viewedAt,
          IMPRESSION_DELAY_MS,
          () => !stopped && !row.suspended() && row.epoch() === earnedEpoch,
        )
        .catch(() => {
          // A rejected impression must not cost the session its next one: the ad
          // that was refused is still on the row, but its signature is spent, so
          // only a rotation can earn again — which is exactly what happens next.
        });
    }, IMPRESSION_DELAY_MS);
    // Unreferenced so a pending dwell is never the reason the process is still
    // alive; the child's exit is what ends the session.
    dwellTimer.unref();
  };

  const paint = (): string => {
    if (stopped) return '';
    const bytes = row.paint(ad);
    // Empty means the valve is shut — the child holds the alternate screen — and
    // an ad nobody can see must not be accruing a dwell.
    if (bytes.length === 0) return '';
    lastRepaintAt = Date.now();
    armDwell();
    return bytes;
  };

  /**
   * Take a fresh ad for the row, and with it a fresh impression to earn.
   *
   * Skipped while the child holds the alternate screen: a signature expires five
   * minutes after it is minted, so fetching copy that cannot be painted spends
   * an ad on an editor session and leaves the row holding the previous one
   * anyway.
   */
  const rotate = async (): Promise<void> => {
    if (stopped || row.suspended()) return;

    let next: Ad | null;
    try {
      next = await client.fetchCurrentAd(abort.signal);
    } catch {
      return;
    }
    if (next === null || stopped) return;

    ad = next;
    credited = false;
    clearTimeout(dwellTimer);
    dwellTimer = undefined;
    process.stdout.write(paint());
  };

  const rotateTimer = setInterval(() => void rotate(), AD_ROTATION_MS);
  rotateTimer.unref();

  return {
    paint,

    touched(): void {
      if (stopped) return;
      const now = Date.now();

      // If continuous output has been streaming for longer than MAX_REPAINT_GAP_MS,
      // repaint immediately to prevent the ad from being starved off the screen
      // while an agent is thinking or running a long command.
      if (now - lastRepaintAt >= MAX_REPAINT_GAP_MS) {
        lastRepaintAt = now;
        clearTimeout(repaintTimer);
        repaintTimer = undefined;
        const bytes = paint();
        if (bytes.length > 0) process.stdout.write(bytes);
        return;
      }

      // Debounced for burst settlement when streaming pauses or finishes.
      clearTimeout(repaintTimer);
      repaintTimer = setTimeout(() => {
        repaintTimer = undefined;
        lastRepaintAt = Date.now();
        const bytes = paint();
        if (bytes.length > 0) process.stdout.write(bytes);
      }, RESERVED_ROW_REPAINT_MS);
      repaintTimer.unref();
    },

    async stop(): Promise<void> {
      stopped = true;
      clearTimeout(dwellTimer);
      clearTimeout(repaintTimer);
      clearInterval(rotateTimer);
      if (pendingImpression !== undefined) {
        await Promise.race([pendingImpression, delay(IMPRESSION_GRACE_MS)]);
      }
      abort.abort();
    },
  };
}

/** The input side of the earn loop. See "Prompt-triggered ads" above. */
interface PromptAds {
  /** Called for every keystroke batch that submitted something to the child. */
  onSubmit(): void;
  /** Abandon an in-flight fetch and cancel a dwell that has not been earned. */
  stop(): void;
}

/**
 * Show a fresh ad on the row the child parked its cursor on each time the user
 * submits a prompt, and credit it if it survives the dwell.
 *
 * Everything here is best-effort in the same way the banner is: a fetch that
 * fails, a row the injector refuses to lend, an impression the backend rejects.
 * None of them are the developer's problem, and none of them touch the relay.
 */
function startPromptAds(injector: AdInjector, client: AdClient): PromptAds {
  /** Bounds every request to the session, so the exit path can drop them all. */
  const abort = new AbortController();
  /** Timers for injections still inside their dwell window. */
  const dwells = new Set<NodeJS.Timeout>();
  let stopped = false;
  let lastAt = 0;
  /** True from the keystroke until its fetch settles: one request at a time. */
  let fetching = false;

  const show = async (): Promise<void> => {
    let ad: Ad | null;
    try {
      // Deliberately not the cached ad from the banner: its tracking signature
      // is single-use, so an impression on it would be rejected. This is the
      // "cache bypass" — every prompt is paid for by its own placement.
      ad = await client.fetchCurrentAd(abort.signal);
    } catch {
      return;
    }
    // The child may well have exited while this was in flight.
    if (ad === null || stopped) return;

    const bytes = injector.inject(ad);
    // The injector declined the row — a full-screen TUI owns the screen, or the
    // child owes the terminal the rest of an escape sequence.
    if (bytes.length === 0) return;

    process.stdout.write(bytes);
    startDwell(ad, injector.injectionId());
  };

  /**
   * Credit `ad` once it has held the row for the dwell time.
   *
   * `injectionId` is the whole test. The row belongs to the child, which takes
   * it back with its next byte of output, so "5 seconds later" says nothing on
   * its own about whether the ad was on screen for any of them. An id that is
   * still current means nothing has repainted that row since — the agent really
   * did stay quiet, and the ad really was visible throughout.
   */
  const startDwell = (ad: Ad, injectionId: number | undefined): void => {
    const timer = setTimeout(() => {
      dwells.delete(timer);
      if (injector.injectionId() !== injectionId) return;

      // Dated backwards from now: the ad went up when the timer was set, and
      // the dwell it just proved is the window the developer is paid for.
      const viewedAt = new Date(Date.now() - IMPRESSION_DELAY_MS);
      void client
        .recordImpression(
          ad,
          viewedAt,
          IMPRESSION_DELAY_MS,
          () => injector.injectionId() === injectionId,
        )
        .catch(() => {});
    }, IMPRESSION_DELAY_MS);

    // Unreferenced so a pending dwell is never the reason the process is still
    // alive; the child's exit is what ends the session.
    timer.unref();
    dwells.add(timer);
  };

  return {
    onSubmit(): void {
      const now = Date.now();
      if (stopped || fetching || now - lastAt < PROMPT_AD_COOLDOWN_MS) return;

      lastAt = now;
      fetching = true;
      void show().finally(() => {
        fetching = false;
      });
    },

    stop(): void {
      stopped = true;
      abort.abort();
      for (const timer of dwells) clearTimeout(timer);
      dwells.clear();
    },
  };
}

function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    [WRAPPED_ENV_VAR]: '1',
  };
}

/**
 * Whether `keys` — one batch of raw keystrokes — submitted something to the
 * child.
 *
 * A newline anywhere in the batch counts, not just at the end: a paste, or fast
 * typing coalesced into one read, can carry the Enter in the middle. What does
 * *not* count is a newline inside pasted text. Terminals wrap a paste in
 * bracketed-paste markers, and an agent that enabled them treats the whole
 * payload as literal text — the newlines in a pasted three-line prompt are
 * content, not submissions, and the real Enter comes in a later batch. Rather
 * than track paste state across reads, a batch that opens one is skipped
 * outright: worst case the ad for that prompt is missed, which is much cheaper
 * than firing on every line of a pasted file.
 *
 * A false positive costs a wasted fetch (bounded by
 * {@link PROMPT_AD_COOLDOWN_MS}) and, at worst, a sponsored line on a row the
 * child immediately repaints — which is exactly what the injector's design
 * already assumes.
 */
function submitted(keys: string): boolean {
  if (keys.includes(PASTE_START)) return false;

  for (const key of keys) {
    if (SUBMIT_KEYS.has(key)) return true;
  }
  return false;
}

/** {@link childEnv} with unset variables dropped: a pty cannot carry `undefined`. */
function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(childEnv())) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function signalNumber(signal: NodeJS.Signals): number {
  return osConstants.signals[signal] ?? 0;
}

/** `unref`ed so the delay itself never keeps the process alive. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
