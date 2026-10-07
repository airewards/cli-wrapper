/**
 * The reserved-row interception strategy.
 *
 * `injector.ts` borrows a row the child parked its cursor on. That works
 * beautifully for an agent drawing one throwaway status line at the bottom of a
 * scrolling stream, and not at all for the agents that matter most — `codex`,
 * `cline` and anything else built on absolute positioning. Those own the screen:
 * they position their cursor by coordinate, repaint whole regions, and have no
 * disposable row to lend. Borrowing one from them means landing an erase in the
 * middle of a frame they are still drawing.
 *
 * So this strategy stops asking the child for a row and takes one instead, by
 * making the child believe the terminal is one row shorter than it is. Four
 * pieces, and each is load-bearing:
 *
 * - **The lie.** The pty is allocated with `rows - 1` (see `childRows`), so
 *   every `TIOCGWINSZ` the child makes — at startup and on every SIGWINCH —
 *   reports a window whose last row is the second-to-last real one. An agent
 *   that positions absolutely therefore addresses coordinates that stop one row
 *   above ours, without knowing anything has been withheld.
 * - **The fence.** The lie is not enough on its own, because scrolling is not
 *   addressed by coordinate: a line feed on the bottom row scrolls the whole
 *   screen, our row included, whatever the child believes about the height. So
 *   the scrolling region is restricted with DECSTBM (`CSI 1 ; rows-1 r`), which
 *   confines every scroll the child causes to the rows above ours.
 * - **The guard.** The child sets its own margins too, and a full-screen TUI
 *   resetting the region (`CSI r`) would silently hand itself our row back. So
 *   its output stream is tokenized and every DECSTBM in it is rewritten to keep
 *   the fence — see {@link clampScrollRegion}.
 * - **The paint.** Our row is written by cursor-save, absolute-position,
 *   write, erase-to-end-of-line, cursor-restore, so the child's cursor is
 *   exactly where it left it afterwards. Nothing about our write is visible to
 *   the child, and nothing about the child's frame is disturbed by it.
 *
 * ## The alternate screen valve
 *
 * All four pieces assume the primary screen buffer. The moment the child swaps
 * in the alternate one (`CSI ? 1049 h` — `vim`, `nano`, `less`, a full-screen
 * diff viewer), that assumption is gone: the alternate buffer is a different
 * screen with its own margins, and the row we reserved does not exist on it in
 * any sense we can reason about. Painting there writes into an editor's own
 * canvas.
 *
 * So the valve is unconditional: on `?1049h` painting stops, and it does not
 * resume until `?1049l`. On the way back the fence is re-issued, because a
 * terminal that saved margins on the way in has restored the child's, not ours,
 * and because a child that set its own inside the alternate buffer left them
 * behind. Earning stops with the painting — an ad nobody can see is not an
 * impression, which is why {@link ReservedRow.epoch} exists rather than a plain
 * boolean: it lets the earn loop tell "the row has been ours all along" from
 * "the row was taken and given back while I was waiting".
 *
 * ## Truncated sequences
 *
 * A chunk off a pty master is cut at an arbitrary byte, so an escape sequence
 * can straddle two reads. This module cannot pass a half-sequence through, for
 * two independent reasons: a DECSTBM cut across the boundary would reach the
 * terminal unrewritten, and our own paint — written between chunks — would be
 * swallowed as the continuation of whatever the child left open. So the
 * incomplete tail is held back and prepended to the next chunk
 * ({@link tokenizeAnsi} reports it separately for exactly this). It is bytes the
 * terminal could not have rendered yet either way, and holding them is what
 * makes "the stream is always at a sequence boundary between chunks" true —
 * which is what makes painting safe at all.
 */

import { tokenizeAnsi } from './ansi-scan.js';
import type { Ad } from './api.js';
import { sponsoredLine } from './sponsored.js';

const ESC = '\u001B';

/** DECSC / DECRC — save and restore the cursor, the paint's outer brackets. */
const SAVE_CURSOR = `${ESC}7`;
const RESTORE_CURSOR = `${ESC}8`;

/** Erase from the cursor to the end of the row. */
const ERASE_TO_EOL = `${ESC}[K`;

/** DECSTBM with no parameters: "the scrolling region is the whole screen". */
const RESET_SCROLL_REGION = `${ESC}[r`;

/** Private modes that swap in the alternate screen buffer. */
const ALT_SCREEN_MODES = new Set(['?1049', '?1047', '?47']);

/**
 * Parameters DECSTBM can actually carry: digits and semicolons.
 *
 * The test matters because `r` is not exclusively DECSTBM. `CSI ? 1049 r` is
 * XTRESTORE — restore private mode settings — and rewriting its parameters as
 * though they were margins would corrupt an unrelated sequence. A leading `?`
 * (or `>`, or any other private marker) is what tells them apart.
 */
const SCROLL_REGION_PARAMS = /^[0-9;]*$/;

/** Rows withheld from the child. One, and the arithmetic below assumes it. */
export const RESERVED_ROWS = 1;

/**
 * The height the child is told the terminal has.
 *
 * Floored at 1 so the arithmetic cannot produce a pty with zero rows, though
 * {@link reservedRowViable} rejects a window that small long before this.
 */
export function childRows(rows: number): number {
  return Math.max(rows - RESERVED_ROWS, 1);
}

/**
 * Whether a window is tall enough to give a row away.
 *
 * Three is the floor: at two rows the child is left with one, which is not
 * enough for any agent to draw in, and at one row the reserved row *is* the
 * child's row. A window that small relays under the borrowed-status-line
 * strategy instead, which needs no space of its own.
 */
export function reservedRowViable(rows: number): boolean {
  return rows >= RESERVED_ROWS + 2;
}

/** The stream half of the strategy: fence maintenance and the paint itself. */
export interface ReservedRow {
  /**
   * Bytes that establish (or re-establish) the fence. Written once before the
   * child's first output, and again whenever the terminal may have forgotten it.
   */
  fence(): string;
  /**
   * Map one chunk of child output to the bytes that should reach the terminal:
   * DECSTBM rewritten, alt-screen transitions noted, an incomplete trailing
   * sequence held back for the next call.
   */
  transform(chunk: string): string;
  /**
   * Bytes that paint `ad` on the reserved row, or an empty string while the
   * child owns the alternate screen buffer.
   */
  paint(ad: Ad): string;
  /** Adopt a new window size and return the fence for it. */
  resize(columns: number, rows: number): string;
  /** True while painting is valved off — the child holds the alternate screen. */
  suspended(): boolean;
  /**
   * Counter that changes whenever the reserved row stopped being ours: an
   * alt-screen entry, or a resize that moved the row.
   *
   * The earn loop compares it across its dwell window. An unchanged epoch is
   * the proof that the ad it painted was on screen for every moment of it.
   */
  /**
   * Counter that changes whenever the reserved row stopped being continuously ours: an
   * alt-screen entry, or a resize that moved the row.
   *
   * The earn loop compares it across its dwell window. An unchanged epoch is
   * the proof that the ad it painted was on screen for every moment of it.
   */
  epoch(): number;
  /**
   * Whether the row was cleared (e.g. by Erase Display or screen buffer switch)
   * and needs an immediate repaint so the ad does not disappear while the child
   * is thinking or running commands.
   */
  needsRepaint(): boolean;
  /** Bytes that clear the reserved row and give the whole screen back. */
  flush(): string;
}

/** Build a reserved-row strategy for a `columns`×`rows` window. */
export function createReservedRow(columns: number, rows: number): ReservedRow {
  let width = columns;
  let height = rows;
  /** True from `?1049h` until `?1049l`. See "The alternate screen valve". */
  let altScreen = false;
  /** Bumped whenever the row stopped being continuously ours. */
  let generation = 0;
  /** An incomplete escape sequence from the end of the last chunk. */
  let held = '';
  /** True when the chunk contained a display erasure or buffer switch. */
  let repaintNeeded = false;

  /**
   * `CSI 1 ; childRows r`, bracketed by cursor save/restore.
   *
   * DECSTBM homes the cursor as a side effect, which is harmless before the
   * child's first byte and destructive at any point after it — the child would
   * carry on drawing from wherever it thought it was. Saving and restoring
   * around it makes the fence invisible in the one way that matters.
   */
  const fenceBytes = (): string => `${SAVE_CURSOR}${ESC}[1;${childRows(height)}r${RESTORE_CURSOR}`;

  /** Move to the first column of the reserved row: the last real one. */
  const toReservedRow = (): string => `${ESC}[${height};1H`;

  return {
    fence: fenceBytes,

    transform(chunk: string): string {
      const { tokens, truncated } = tokenizeAnsi(held + chunk);
      held = truncated;

      let out = '';
      /** Appended after the chunk when the child came back from alt-screen. */
      let refence = false;

      for (const token of tokens) {
        if (token.kind !== 'csi') {
          out += token.raw;
          continue;
        }

        if (token.final === 'r' && SCROLL_REGION_PARAMS.test(token.params)) {
          // The child is claiming a scrolling region. Whatever it asked for, it
          // gets one that stops above our row — see `clampScrollRegion`.
          out += `${ESC}[${clampScrollRegion(token.params, childRows(height))}r`;
          continue;
        }

        // Erase in Display: CSI J, 0J, 2J, 3J all clear down to the bottom
        // of the terminal, wiping the reserved row. Catching this allows an
        // immediate repaint in the same chunk so the ad never disappears.
        if (token.final === 'J' && token.params !== '1') {
          repaintNeeded = true;
        }

        out += token.raw;

        if (!ALT_SCREEN_MODES.has(token.params)) continue;
        if (token.final === 'h' && !altScreen) {
          altScreen = true;
          // The screen buffer swapped; move the epoch so any in-flight dwell resets
          // and re-fence the alternate screen so its scrolling region stops above our row.
          generation += 1;
          refence = true;
          repaintNeeded = true;
        } else if (token.final === 'l' && altScreen) {
          altScreen = false;
          generation += 1;
          refence = true;
          repaintNeeded = true;
        }
      }

      // The fence goes out after the sequence that switched screen buffers,
      // so it lands on the active buffer it is meant to constrain.
      return refence ? out + fenceBytes() : out;
    },

    paint(ad: Ad): string {
      // Erase *after* the copy rather than before it: a shorter ad than the one
      // it replaces would otherwise leave the old line's tail on the row, and
      // erasing first would show the row empty for one frame.
      return `${SAVE_CURSOR}${toReservedRow()}${sponsoredLine(ad, undefined, width)}${ERASE_TO_EOL}${RESTORE_CURSOR}`;
    },

    resize(nextColumns: number, nextRows: number): string {
      const moved = nextRows !== height;
      width = nextColumns;
      height = nextRows;
      // A window that changed height moved the reserved row out from under
      // whatever was painted on it: the old row now belongs to the child.
      if (moved) generation += 1;
      return fenceBytes();
    },

    suspended(): boolean {
      return false;
    },

    epoch(): number {
      return generation;
    },

    needsRepaint(): boolean {
      if (repaintNeeded) {
        repaintNeeded = false;
        return true;
      }
      return false;
    },

    flush(): string {
      // The held tail is deliberately dropped: it is the first half of a
      // sequence whose remainder the child will never send now, and passing it
      // on would leave the terminal parsing our cleanup as its parameters.
      held = '';
      const clear = `${SAVE_CURSOR}${toReservedRow()}${ERASE_TO_EOL}${RESTORE_CURSOR}`;
      // The region goes back to the full screen last, so the shell that inherits
      // this terminal can scroll all of it.
      return `${clear}${RESET_SCROLL_REGION}`;
    },
  };
}

/**
 * Rewrite DECSTBM parameters so the region can never include the reserved row.
 *
 * Three cases, and the empty one is the dangerous one. `CSI r` means "reset the
 * region to the whole screen", which is precisely the sequence that would give
 * our row back — and it is what a TUI emits on the way out of a mode it set
 * margins for. It is rewritten to the fence rather than dropped, because the
 * child is entitled to the reset it asked for over the rows it can see.
 *
 * A bottom margin at or below the fence is left exactly as the child wrote it:
 * an agent that reserves rows of its own is doing something we do not need to
 * second-guess, as long as it stays inside its own screen.
 */
export function clampScrollRegion(params: string, bottom: number): string {
  if (params.length === 0) return `1;${bottom}`;

  const [top, requested] = params.split(';');
  const first = Number.parseInt(top ?? '', 10);
  const last = Number.parseInt(requested ?? '', 10);

  // `CSI 5 r` — a top margin with the bottom left implicit, which means "to the
  // bottom of the screen" and has to be pinned to the fence instead.
  const start = Number.isNaN(first) || first < 1 ? 1 : first;
  const end = Number.isNaN(last) ? bottom : Math.min(last, bottom);

  // A region the clamp inverted (`CSI 30;40 r` on a 24-row window) is not a
  // region at all; the terminal ignores an invalid DECSTBM, and the fence is the
  // safest thing to leave in force.
  if (start >= end) return `1;${bottom}`;
  return `${start};${end}`;
}
