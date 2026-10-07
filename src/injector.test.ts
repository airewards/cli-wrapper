/**
 * The injector is the one module in the wrapper that writes to a row the child
 * also owns, so every case here is framed the same way: feed the chunks a real
 * agent emits, and assert on the bytes that reach the screen.
 *
 * Two properties carry most of the weight. The row must be handed back before
 * the child's own bytes land, and `injectionId` must hold still for as long as
 * the ad is genuinely on screen — that id is what the earn loop pays out on.
 */

import { describe, expect, it } from 'vitest';
import type { Ad } from './api.js';
import { createAdInjector } from './injector.js';

/** Built rather than written literally, so no raw control byte lives in source. */
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

/** The rewrite primitive: rewind to column 0, erase the row. */
const ERASE = `${ESC}[K`;
const ERASE_LINE = `\r${ERASE}`;
/** Swap in the alternate screen buffer, as a full-screen TUI does on launch. */
const ALT_SCREEN_ON = `${ESC}[?1049h`;
/** Move the cursor up a row — the child painting somewhere it did not park. */
const CURSOR_UP = `${ESC}[A`;

const AD: Ad = {
  adId: 'ad_1',
  text: 'Ship faster with Acme CI',
  url: 'https://acme.test/cli',
  trackingSignature: 'sig_1',
};

/** OSC 8 hyperlinks: consumed by the terminal, never displayed. */
const OSC = new RegExp(`${ESC}\\]8;;[^${ESC}${BEL}]*(?:${ESC}\\\\|${BEL})`, 'g');
/** CSI sequences: likewise. */
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');

/** What a terminal would end up displaying on the row `bytes` finishes on. */
function visible(bytes: string): string {
  const plain = bytes.replace(OSC, '').replace(CSI, '');
  return plain.slice(Math.max(plain.lastIndexOf('\n'), plain.lastIndexOf('\r')) + 1);
}

/** An injector already holding the row, with the id the ad went up under. */
function holding(frame = '⠙ Thinking…') {
  const ads = createAdInjector(AD, 80);
  const painted = ads.transform(frame);
  const id = ads.injectionId();
  expect(id).toBeDefined();
  return { ads, painted, id };
}

// ---------------------------------------------------------------------------
// 1. A spinner frame causes an ad to be painted on the status line.
// ---------------------------------------------------------------------------
describe('transform — spinner detection', () => {
  it('paints the ad after a braille spinner frame', () => {
    const ads = createAdInjector(AD, 80);
    const out = ads.transform('⠙ Thinking…');
    expect(visible(out)).toContain(AD.text);
  });

  it('paints the ad after a strong-phrase status line', () => {
    const ads = createAdInjector(AD, 80);
    const out = ads.transform('Thinking…');
    expect(visible(out)).toContain(AD.text);
  });

  it('does not paint on a plain newline-terminated chunk', () => {
    const ads = createAdInjector(AD, 80);
    const out = ads.transform('Some output\n');
    expect(visible(out)).not.toContain(AD.text);
    expect(ads.injectionId()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 1b. Un-ellipsised status rows — OpenAI Codex.
//
// Codex writes `• Working (6s • esc to interrupt)`: a weak glyph, no ellipsis,
// and a counter that is the only part changing between ticks. Every row here is
// rewritten in place, because that is the premise the borrow rests on — the
// closing cases are the same wording *appended*, which is prose.
// ---------------------------------------------------------------------------
describe('transform — un-ellipsised status rows', () => {
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    ['openai codex frame', `${ERASE_LINE}• Working (6s • esc to interrupt)`, true],
    ['codex frame, timer only', `${ERASE_LINE}• Working (6s)`, true],
    ['codex frame, no hint at all', `${ERASE_LINE}• Working`, true],
    ['codex frame, minutes counter', `${ERASE_LINE}• Working (1m05s • esc to interrupt)`, true],
    ['tool label under a counter', `${ERASE_LINE}• Running tests (8s)`, true],
    ['undecorated waiting verb', `${ERASE_LINE}Loading (3s)`, true],
    // The row is only borrowable because the child rewrote it. Appended, the
    // identical bytes are a markdown bullet the child means to keep.
    ['bulleted prose, appended', '• Working on the parser', false],
    ['bulleted prose with a number', '• Working on 3 files', false],
    ['bulleted markdown list item', '• Install the CLI first', false],
  ];

  for (const [name, frame, painted] of cases) {
    it(`${painted ? 'paints on' : 'ignores'} ${name}`, () => {
      const ads = createAdInjector(AD, 80);
      const out = ads.transform(frame);
      expect(visible(out).includes(AD.text)).toBe(painted);
      expect(ads.injectionId() !== undefined).toBe(painted);
    });
  }

  it('keeps the bullet glyph on the sponsored row', () => {
    const ads = createAdInjector(AD, 80);
    const out = ads.transform(`${ERASE_LINE}• Working (6s • esc to interrupt)`);
    expect(visible(out).startsWith('• ')).toBe(true);
  });

  it('hands the row back when the child appends real output', () => {
    const { ads } = holding(`${ERASE_LINE}• Working (6s • esc to interrupt)`);
    const out = ads.transform('Done in 6s\n');
    expect(out).toContain(ERASE_LINE);
    expect(out).toContain('Done in 6s');
    expect(ads.injectionId()).toBeUndefined();
  });

  it('swallows the next codex tick so the dwell can run', () => {
    const { ads, id } = holding(`${ERASE_LINE}• Working (6s • esc to interrupt)`);
    expect(ads.transform(`${ERASE_LINE}• Working (7s • esc to interrupt)`)).toBe('');
    expect(ads.injectionId()).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// 4–5. injectionId lifecycle.
// ---------------------------------------------------------------------------
describe('injectionId', () => {
  it('is undefined before any injection', () => {
    const ads = createAdInjector(AD, 80);
    expect(ads.injectionId()).toBeUndefined();
  });

  it('is defined after a spinner frame is transformed', () => {
    const { id } = holding();
    expect(id).toBeDefined();
  });

  it('is cleared after a newline chunk erases the ad', () => {
    const { ads } = holding();
    ads.transform('Real output\n');
    expect(ads.injectionId()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6–8. Repaint suppression — the ad lock.
// ---------------------------------------------------------------------------
describe('repaint suppression', () => {
  it('swallows a subsequent spinner frame while an ad is live', () => {
    const { ads } = holding();
    const out = ads.transform('⠹ Thinking…');
    expect(out).toBe('');
  });

  it('leaves injectionId unchanged when a frame is swallowed', () => {
    const { ads, id } = holding();
    ads.transform('⠹ Thinking…');
    expect(ads.injectionId()).toBe(id);
  });

  it('releases the row and outputs the chunk when a newline arrives', () => {
    const { ads } = holding();
    const out = ads.transform('Real output\n');
    // The ad erase must precede the child's bytes.
    expect(out).toContain(ERASE_LINE);
    expect(out).toContain('Real output');
    expect(ads.injectionId()).toBeUndefined();
  });

  it('releases the row when the alt-screen is toggled on', () => {
    const { ads } = holding();
    const out = ads.transform(ALT_SCREEN_ON);
    expect(out).toContain(ERASE_LINE);
    expect(ads.injectionId()).toBeUndefined();
  });

  it('releases the row when a cursor-up appears in the chunk', () => {
    const { ads } = holding();
    // A cursor-up anywhere in the chunk means the child is drawing off-row.
    const out = ads.transform(`${CURSOR_UP}⠹ Thinking…`);
    expect(out).toContain(ERASE_LINE);
    expect(ads.injectionId()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 9–10. inject() and erase() — the input-driven path.
// ---------------------------------------------------------------------------
describe('inject / erase', () => {
  it('inject() paints the ad and returns non-empty bytes', () => {
    const ads = createAdInjector(AD, 80);
    const out = ads.inject(AD);
    expect(out).not.toBe('');
    expect(visible(out)).toContain(AD.text);
    expect(ads.injectionId()).toBeDefined();
  });

  it('erase() clears the row and resets injectionId', () => {
    const ads = createAdInjector(AD, 80);
    ads.inject(AD);
    const out = ads.erase();
    expect(out).toContain(ERASE_LINE);
    expect(ads.injectionId()).toBeUndefined();
  });

  it('inject() is a no-op while the alt-screen is active', () => {
    const ads = createAdInjector(AD, 80);
    ads.transform(ALT_SCREEN_ON);
    expect(ads.inject(AD)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 13. flush() — terminal cleanup on child exit.
// ---------------------------------------------------------------------------
describe('flush', () => {
  it('returns the erase sequence when an ad is on screen', () => {
    const { ads } = holding();
    expect(ads.flush()).toContain(ERASE_LINE);
  });

  it('returns empty string when nothing is on screen', () => {
    const ads = createAdInjector(AD, 80);
    expect(ads.flush()).toBe('');
  });
});
