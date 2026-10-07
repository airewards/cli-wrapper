/**
 * The reserved row is the one strategy that writes to the screen without being
 * asked, so every case here is about the three things that make that safe: the
 * fence cannot be taken down by the child, the paint cannot be seen by it, and
 * both stop dead while an editor owns the screen.
 *
 * `epoch` carries the earn loop, so its transitions are asserted directly — an
 * impression is only ever paid against an epoch that held still.
 */

import { describe, expect, it } from 'vitest';
import type { Ad } from './api.js';
import {
  childRows,
  clampScrollRegion,
  createReservedRow,
  reservedRowViable,
} from './reserved-row.js';

/** Built rather than written literally, so no raw control byte lives in source. */
const ESC = String.fromCharCode(0x1b);

const SAVE_CURSOR = `${ESC}7`;
const RESTORE_CURSOR = `${ESC}8`;
const ERASE_TO_EOL = `${ESC}[K`;
const ALT_SCREEN_ON = `${ESC}[?1049h`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;

const AD: Ad = {
  adId: 'ad_1',
  text: 'Ship faster with Acme CI',
  url: 'https://acme.test/cli',
  trackingSignature: 'sig_1',
};

/** A 24-row window, so the fence is `1;23` and the ad row is 24. */
const ROWS = 24;
const COLUMNS = 80;
const FENCE = `${ESC}[1;23r`;

function row() {
  return createReservedRow(COLUMNS, ROWS);
}

describe('childRows / reservedRowViable', () => {
  it('withholds exactly one row', () => {
    expect(childRows(24)).toBe(23);
  });

  it('never reports a pty with no rows at all', () => {
    expect(childRows(1)).toBe(1);
    expect(childRows(0)).toBe(1);
  });

  it('refuses a window with no row to spare', () => {
    expect(reservedRowViable(2)).toBe(false);
    expect(reservedRowViable(3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The fence.
// ---------------------------------------------------------------------------
describe('fence', () => {
  it('restricts the scrolling region to the rows above the reserved one', () => {
    expect(row().fence()).toContain(FENCE);
  });

  it('brackets the region change in cursor save/restore', () => {
    // DECSTBM homes the cursor, which would leave the child drawing from the
    // wrong place if the fence were not invisible to it.
    const bytes = row().fence();
    expect(bytes.startsWith(SAVE_CURSOR)).toBe(true);
    expect(bytes.endsWith(RESTORE_CURSOR)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The guard: DECSTBM interception.
// ---------------------------------------------------------------------------
describe('transform — scroll region interception', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['a full reset', `${ESC}[r`, `${ESC}[1;23r`],
    ['a region that would include our row', `${ESC}[1;24r`, `${ESC}[1;23r`],
    ['a top margin with an implicit bottom', `${ESC}[5r`, `${ESC}[5;23r`],
    ['an inverted region', `${ESC}[30;40r`, `${ESC}[1;23r`],
  ];

  for (const [name, emitted, rewritten] of cases) {
    it(`rewrites ${name}`, () => {
      expect(row().transform(emitted)).toBe(rewritten);
    });
  }

  it('leaves a region the child kept inside its own screen alone', () => {
    expect(row().transform(`${ESC}[3;20r`)).toBe(`${ESC}[3;20r`);
  });

  it('leaves XTRESTORE alone', () => {
    // `CSI ? 1049 r` is not DECSTBM at all; rewriting its parameters as margins
    // would corrupt an unrelated sequence.
    expect(row().transform(`${ESC}[?1049r`)).toBe(`${ESC}[?1049r`);
  });

  it('passes the child bytes around a rewritten region through untouched', () => {
    const out = row().transform(`before${ESC}[rafter`);
    expect(out).toBe(`before${ESC}[1;23rafter`);
  });
});

// ---------------------------------------------------------------------------
// Truncated sequences.
// ---------------------------------------------------------------------------
describe('transform — chunk boundaries', () => {
  it('holds an incomplete sequence back until the next chunk completes it', () => {
    const reserved = row();
    // `CSI 1;2` — the final byte is in the next read. Passing it on would let a
    // DECSTBM reach the terminal unrewritten.
    expect(reserved.transform(`text${ESC}[1;2`)).toBe('text');
    expect(reserved.transform('4r')).toBe(`${ESC}[1;23r`);
  });

  it('holds a bare trailing ESC back', () => {
    const reserved = row();
    expect(reserved.transform(`text${ESC}`)).toBe('text');
    expect(reserved.transform('[K')).toBe(`${ESC}[K`);
  });
});

// ---------------------------------------------------------------------------
// The paint.
// ---------------------------------------------------------------------------
describe('paint', () => {
  it('writes the ad on the last real row and restores the cursor', () => {
    const bytes = row().paint(AD);
    expect(bytes.startsWith(SAVE_CURSOR)).toBe(true);
    expect(bytes).toContain(`${ESC}[${ROWS};1H`);
    expect(bytes).toContain(AD.text);
    expect(bytes).toContain(ERASE_TO_EOL);
    expect(bytes.endsWith(RESTORE_CURSOR)).toBe(true);
  });

  it('erases after the copy, so a shorter ad leaves no tail behind', () => {
    const bytes = row().paint(AD);
    expect(bytes.indexOf(AD.text)).toBeLessThan(bytes.indexOf(ERASE_TO_EOL));
  });
});

// ---------------------------------------------------------------------------
// The alt-screen buffer handling.
// ---------------------------------------------------------------------------
describe('alternate screen handling', () => {
  it('re-issues the fence when the child enters the alternate screen', () => {
    const reserved = row();
    const out = reserved.transform(ALT_SCREEN_ON);
    expect(out.indexOf(ALT_SCREEN_ON)).toBeLessThan(out.indexOf(FENCE));
  });

  it('re-issues the fence after the child leaves the alternate screen', () => {
    const reserved = row();
    reserved.transform(ALT_SCREEN_ON);
    const out = reserved.transform(ALT_SCREEN_OFF);
    // After the mode change, so the margins land on the primary screen.
    expect(out.indexOf(ALT_SCREEN_OFF)).toBeLessThan(out.indexOf(FENCE));
  });

  it('continues painting the ad when the child takes the alternate screen', () => {
    const reserved = row();
    reserved.transform(ALT_SCREEN_ON);
    expect(reserved.suspended()).toBe(false);
    expect(reserved.paint(AD)).toContain(AD.text);
  });

  it('re-fences on older alt-screen modes too', () => {
    const reserved = row();
    const out = reserved.transform(`${ESC}[?47h`);
    expect(out).toContain(FENCE);
  });

  it('passes the mode change itself through to the terminal', () => {
    // The agent still needs its alternate screen; the fence is appended,
    // not replacing the child's own bytes.
    expect(row().transform(ALT_SCREEN_ON)).toContain(ALT_SCREEN_ON);
  });
});

// ---------------------------------------------------------------------------
// epoch — what the earn loop pays out on.
// ---------------------------------------------------------------------------
describe('epoch', () => {
  it('holds still while the row is continuously ours', () => {
    const reserved = row();
    const before = reserved.epoch();
    reserved.transform('streamed output\n');
    reserved.paint(AD);
    expect(reserved.epoch()).toBe(before);
  });

  it('changes when the child takes the alternate screen', () => {
    const reserved = row();
    const before = reserved.epoch();
    reserved.transform(ALT_SCREEN_ON);
    expect(reserved.epoch()).not.toBe(before);
  });

  it('changes when a resize moves the reserved row', () => {
    const reserved = row();
    const before = reserved.epoch();
    reserved.resize(COLUMNS, ROWS - 4);
    expect(reserved.epoch()).not.toBe(before);
  });

  it('holds still when only the width changed', () => {
    const reserved = row();
    const before = reserved.epoch();
    reserved.resize(COLUMNS + 10, ROWS);
    expect(reserved.epoch()).toBe(before);
  });

  it('does not change again while the alternate screen is merely repainted', () => {
    const reserved = row();
    reserved.transform(ALT_SCREEN_ON);
    const during = reserved.epoch();
    reserved.transform(ALT_SCREEN_ON);
    expect(reserved.epoch()).toBe(during);
  });
});

// ---------------------------------------------------------------------------
// resize and flush.
// ---------------------------------------------------------------------------
describe('resize', () => {
  it('fences against the new height', () => {
    const reserved = row();
    expect(reserved.resize(COLUMNS, 40)).toContain(`${ESC}[1;39r`);
  });

  it('paints on the new bottom row afterwards', () => {
    const reserved = row();
    reserved.resize(COLUMNS, 40);
    expect(reserved.paint(AD)).toContain(`${ESC}[40;1H`);
  });
});

describe('needsRepaint', () => {
  it('reports false when no display clear occurred', () => {
    const reserved = row();
    reserved.transform('plain output without display clear\n');
    expect(reserved.needsRepaint()).toBe(false);
  });

  it('reports true and resets when Erase in Display (CSI J / 2J) is emitted', () => {
    const reserved = row();
    reserved.transform(`${ESC}[2J`);
    expect(reserved.needsRepaint()).toBe(true);
    expect(reserved.needsRepaint()).toBe(false);

    reserved.transform(`some text ${ESC}[J`);
    expect(reserved.needsRepaint()).toBe(true);
    expect(reserved.needsRepaint()).toBe(false);
  });

  it('reports true when entering or exiting alternate screen', () => {
    const reserved = row();
    reserved.transform(ALT_SCREEN_ON);
    expect(reserved.needsRepaint()).toBe(true);
    expect(reserved.needsRepaint()).toBe(false);

    reserved.transform(ALT_SCREEN_OFF);
    expect(reserved.needsRepaint()).toBe(true);
    expect(reserved.needsRepaint()).toBe(false);
  });
});

describe('flush', () => {
  it('clears the reserved row and hands the whole screen back', () => {
    const bytes = row().flush();
    expect(bytes).toContain(`${ESC}[${ROWS};1H`);
    expect(bytes).toContain(ERASE_TO_EOL);
    // The region reset goes last, so the shell inherits a terminal it can
    // scroll all of.
    expect(bytes.endsWith(`${ESC}[r`)).toBe(true);
  });

  it('drops a held partial sequence rather than emitting it', () => {
    const reserved = row();
    reserved.transform(`text${ESC}[1;2`);
    // The child will never send the rest now; passing it on would leave the
    // terminal reading our cleanup as its parameters.
    expect(reserved.flush()).not.toContain(`${ESC}[1;2`);
  });
});

// ---------------------------------------------------------------------------
// clampScrollRegion, directly.
// ---------------------------------------------------------------------------
describe('clampScrollRegion', () => {
  it('turns a reset into the fence', () => {
    expect(clampScrollRegion('', 23)).toBe('1;23');
  });

  it('clamps a bottom margin down to the fence', () => {
    expect(clampScrollRegion('1;24', 23)).toBe('1;23');
  });

  it('keeps a region entirely above the fence', () => {
    expect(clampScrollRegion('4;10', 23)).toBe('4;10');
  });

  it('treats a zero top margin as row one', () => {
    expect(clampScrollRegion('0;10', 23)).toBe('1;10');
  });
});
