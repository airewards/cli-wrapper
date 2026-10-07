/**
 * The one sponsored row, shared by both interception strategies.
 *
 * `injector.ts` paints it over a status line the child parked its cursor on;
 * `reserved-row.ts` paints it on a row the child was never told about. Neither
 * owns the copy: an ad has to read the same way whichever strategy is running,
 * and the clip below is the part that must not diverge — both paint into a
 * single terminal row and take it back down with a single-row erase, so a line
 * that wrapped would leave its first half stranded on screen.
 */

import { hyperlink } from './ansi.js';
import type { Ad } from './api.js';

const CYAN = '\u001B[36m';
const RESET = '\u001B[0m';

/**
 * `✨ [Sponsored] …`, clipped to one terminal row and made clickable.
 *
 * The clip is applied to the visible text before any escape sequence is
 * wrapped around it, so neither the colour codes nor the OSC 8 hyperlink count
 * against the width, and the `RESET` can never be the part that gets cut
 * (which would leak cyan into the child's output).
 *
 * The hyperlink goes outside the colour rather than inside it for the same
 * reason the erase is a single row: whatever we open here has to be closed
 * before the next chunk arrives. Wrapping outermost puts the link's closing
 * sequence last, after `RESET`, so the row is handed back with neither a
 * colour nor a link attribute still in effect.
 *
 * `glyph` is the spinner character the child was cycling, when there was one to
 * borrow, so the sponsored row still signals that something is happening.
 */
export function sponsoredLine(ad: Ad, glyph: string | undefined, columns: number): string {
  const prefix = glyph === undefined ? '' : `${glyph} `;
  const text = `${prefix}✨ [Sponsored] ${ad.text}`;
  // One column short of the edge: writing the last cell makes some terminals
  // wrap the cursor onto the next row, which would break the single-row erase.
  const limit = Math.max(columns - 1, 1);
  const clipped = text.length > limit ? `${text.slice(0, Math.max(limit - 1, 1))}…` : text;
  // No room for a visible URL on a single row, so unlike the pre-spawn banner
  // this line has no plain-text fallback: on a terminal without OSC 8 support it
  // simply reads as the unlinked sponsored line it already was.
  return hyperlink(ad.url, `${CYAN}${clipped}${RESET}`);
}
