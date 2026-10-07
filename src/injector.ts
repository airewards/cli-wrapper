/**
 * Live stream ad injector — the borrowed-status-line strategy.
 *
 * Sits between the pty and the real terminal and rewrites the child's *status
 * line* — the "⠙ Thinking…" row an AI agent paints while it waits on a model —
 * into a sponsored line, then puts the terminal back exactly as the child left
 * it the moment real output resumes.
 *
 * The fallback of the two pty strategies, and chosen when the window is too
 * short to reserve a row of its own or the developer asked for their full height
 * back (see `reserved-row.ts` and "The two pty strategies" in `run.ts`). It needs
 * no space of its own precisely because it owns nothing: every row it writes to
 * is one the child lent it and takes back.
 *
 * ## The rewrite
 *
 * A status line is a line the child wrote *without* a terminating newline: the
 * cursor is parked on it, and the child's own next frame will overwrite it with
 * `\r`. That makes it the one row on screen that is safe to borrow, because the
 * child already treats it as disposable. So when a chunk ends in one, we append
 * `\r\x1b[K` (carriage return, erase to end of line) and paint the ad over it.
 * When the next chunk arrives we lead with the same `\r\x1b[K` to take the ad
 * back down before the child's bytes land, so the child's cursor assumptions
 * hold and its real output is never interleaved with ours.
 *
 * Both halves go out in a single `write`, so the terminal renders chunk and ad
 * together and the spinner does not flicker.
 *
 * ## Where it refuses to act
 *
 * Line rewriting is only sound while the child is drawing one throwaway line at
 * the bottom of a scrolling stream. Two things break that assumption, and both
 * disable injection rather than risk corrupting the agent's own rendering:
 *
 * - **The alternate screen buffer** (`\x1b[?1049h`). A full-screen TUI owns
 *   every cell and repaints on its own schedule; there is no disposable row.
 *   Judged across the whole chunk: an editor that launches mid-stream owns the
 *   screen from that byte onwards, wherever in the chunk it said so.
 * - **A repaint of the status row itself.** Cursor-up/absolute-position/
 *   erase-display sequences mean the child is drawing somewhere other than the
 *   row it parked the cursor on, and our single-row erase would land in the
 *   middle of it. Judged on the chunk's last line only: agents routinely
 *   refresh the block *above* the spinner — Claude Code moves the cursor up to
 *   redraw its tip and context rows — before coming back down to lay the
 *   spinner on a row of its own. Those repaints are finished business by the
 *   time the status line exists, so weighing the whole chunk would refuse a
 *   perfectly ordinary frame on the strength of what came before it.
 *
 * ## The prompt-triggered line
 *
 * Some interactive agents never paint anything this module can recognise as a
 * status line — they clear the screen region they own and sit silent while the
 * model works. For those, `run.ts` drives the same rewrite from the *input*
 * side: when the user submits a prompt it fetches a fresh ad and calls
 * {@link AdInjector.inject}, which borrows the current row exactly as the
 * output path does. It goes through the injector rather than straight to the
 * terminal so there is only ever one writer to that row: the `injected` flag
 * both halves share is what guarantees the ad is taken back down by the leading
 * erase of the next `transform`, instead of two writers fighting over the row.
 *
 * Two of the output path's three refusals carry over to it, and the third
 * cannot. The alternate screen buffer still means there is no disposable row.
 * A chunk that was cut mid-escape-sequence still means the terminal is waiting
 * on bytes the child owes it, and slipping ours in between would complete the
 * child's sequence with our parameters — so an injection is refused until the
 * next chunk resolves it. But a repaint in the last chunk cannot disqualify
 * anything here: by the time the user has typed a prompt and pressed Enter, the
 * child has finished the frame it was drawing and its cursor is parked on the
 * row it considers current. That is the same row {@link AdInjector.transform}
 * borrows, on the same terms — the child is about to repaint it in response to
 * the submission anyway.
 *
 * Because the row is shared, an injection is only *provisionally* on screen:
 * the child's next byte takes it down. {@link AdInjector.injectionId} is how
 * `run.ts` tells the difference when its dwell timer fires — an ad that was
 * erased half a frame after it was painted was never worth an impression.
 *
 * The same caution governs detection: generic words ("working", "loading") only
 * count as a status line once the child has also marked the row as unfinished, a
 * dynamic label ("Transmuting…") is only trusted when the row holds nothing else,
 * and a truncated escape sequence at a chunk boundary is treated as "do not
 * touch".
 *
 * ## The ad lock
 *
 * A spinner exists to be redrawn, and agents redraw it about ten times a second.
 * Each of those frames arrives as its own chunk ending in a status line, so the
 * rewrite above would take the ad down and put it straight back up — with a
 * fresh {@link AdInjector.injectionId} every time. Nothing looks wrong on
 * screen; chunk and ad still go out in one write, so there is no flicker. What
 * breaks is the earn loop. An impression is credited only when the id a dwell
 * timer recorded is still the one on the row five seconds later, and an id that
 * is replaced every ~100ms is never the same id twice: an ad could sit
 * undisturbed for a minute and still earn nothing.
 *
 * So once an ad is on the row, a chunk that does nothing but repaint that same
 * row is swallowed outright — no erase, no redraw, no new id. The ad is already
 * on screen and already correct, and the frame it would have replaced is one the
 * child had itself marked disposable by rewriting it. Suppressing it is what
 * lets the dwell run to completion.
 *
 * The lock has to end the instant the child has something real to say, and the
 * signal for that is a line feed: streamed output appends, and appending is what
 * moves the cursor off the borrowed row. A chunk carrying one — like a chunk
 * that paints away from the row, or takes the screen over — releases the row the
 * ordinary way, erasing the ad before the child's bytes land. Which is also why
 * a frame is only swallowed when it independently reads as a status line *and*
 * was rewritten in place: between them those are what a spinner frame always
 * does and what real output never does, so nothing the child meant to keep can
 * be mistaken for a frame worth dropping.
 *
 * ## Tool-execution frames
 *
 * The rows above are all shapes: a vocabulary, or a short run of words. Agents
 * also narrate the work itself — `✳ Adding inject()/erase() to the injector…` —
 * and there is no shape to that, because the text is whatever the work was
 * about. Identifiers, paths, digits and brackets are exactly what the other
 * patterns reject to keep code and prose off this row.
 *
 * A distinctive spinner glyph settles it on its own, and always did. The hard
 * case is the plain `*` these frames also appear under, since `* Adding retry
 * logic to the client...` is a markdown bullet in streamed prose and identical
 * character for character. An ellipsis cannot separate them — prose trails off
 * too — and getting it wrong means erasing output the child meant to keep.
 *
 * What separates them is not the text but how the row was drawn. A spinner frame
 * is *rewritten*: the child rewinds to column 0 or erases the row, then repaints
 * it, several times a second, which is the same disposability that makes the row
 * borrowable in the first place. Streamed prose only ever appends after a line
 * feed. So a loose ellipsised row under a weak glyph is trusted when the chunk
 * rewrote it in place, and not otherwise — see `reanchored`.
 *
 * ## Rows that were never ellipsised
 *
 * Every shape above leans on the ellipsis somewhere: it is what marks the row as
 * a sentence the child has not finished saying. OpenAI Codex never writes one.
 * Its status row is `• Working (6s • esc to interrupt)` — a bulleted verb and a
 * live counter — and the counter is the only part that changes from frame to
 * frame.
 *
 * Dropping the ellipsis requirement drops the one mark that said the row was
 * unfinished, so two other things have to say it instead. The row must lead with
 * a waiting verb or carry a counter (`WAITING_VERB`, `TIMER_HINT`) — a bulleted
 * line saying anything else is prose — and it must have been rewritten in place,
 * the same `reanchored` test tool-execution frames rest on. A bulleted markdown
 * list is appended once and kept, so it never clears the second bar however much
 * its wording looks like a status row.
 */

import { tokenizeAnsi } from './ansi-scan.js';
import type { Ad } from './api.js';
import { sponsoredLine } from './sponsored.js';

/** Return to column 0 and erase the row — the whole rewrite primitive. */
const ERASE_LINE = '\r\u001B[K';

/**
 * CSI final bytes that mean the child is painting somewhere other than the
 * current row: cursor up/down (`A`,`B`), line up/down (`E`,`F`), absolute
 * position (`H`,`f`,`d`), erase display (`J`), scroll (`S`,`T`), scroll region
 * (`r`). Deliberately excludes `K` (erase line) and `m` (colour), which are
 * exactly what an ordinary single-line spinner emits.
 */
const REPAINT_FINALS = 'ABEFHJSTdfr';

/** Private modes that swap in the alternate screen buffer. */
const ALT_SCREEN_MODES = new Set(['?1049', '?1047', '?47']);

/**
 * Spinner glyphs distinctive enough to mark a status line on their own: the
 * braille/circle/bar frames Node spinner libraries cycle, plus the asterisk
 * family Claude Code cycles (`✳ ✻ ✽ ∗`). None of these occur in prose or code.
 */
const SPINNER_GLYPHS = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷◐◓◑◒◴◷◶◵◜◝◞◟▖▘▝▗▁▂▃▄▅▆▇█✢✣✤✥✦✧✳✱✻✽∗';

/**
 * Glyphs that decorate a spinner frame but are far too ordinary to act on
 * alone — `*` heads markdown bullets, `·`, `•` and `-` head list items. They are
 * stripped before the row is matched, and only count once the rest of the row
 * has independently proven itself a status line. `•` is also the glyph OpenAI
 * Codex heads its status row with, which is the whole reason that row needs the
 * corroboration the rest of this module insists on.
 */
const WEAK_GLYPHS = '*·•+-–>';

/** Unambiguous "the agent is waiting on a model" wording; matched on its own. */
const STRONG_PHRASE = /thinking|consulting the model|esc to interrupt|ctrl-c to (?:stop|cancel)/i;

/**
 * Ambiguous "the agent is busy" wording, as an alternation the two rules below
 * share — one vocabulary, read at two different strengths depending on where in
 * the row it falls.
 */
const WAITING_VERBS =
  'analy[sz]ing|generating|processing|reasoning|planning|compiling|reading|searching|working|loading|waiting';

/** Ambiguous wording; only a status line when the child also ellipsised it. */
const WEAK_PHRASE = new RegExp(WAITING_VERBS, 'i');

/**
 * The same vocabulary, required to *head* the row: `Working (6s • esc to
 * interrupt)`, `Loading`.
 *
 * Where {@link WEAK_PHRASE} is paired with an ellipsis, this is paired with an
 * in-place rewrite, for the rows that never carry one. Anchoring is what takes
 * the ellipsis's place as the narrowing term — a row that *opens* on a waiting
 * verb is announcing a wait, where a sentence that merely contains one is
 * discussing it.
 */
const WAITING_HEAD = new RegExp(`^(?:${WAITING_VERBS})\\b`, 'i');

/**
 * A trailing parenthesised hint holding an elapsed-time counter — `(6s)`,
 * `(41s • esc to interrupt)`, `(3 min)`.
 *
 * The counter is the tell. A row carrying one is being redrawn to advance it,
 * which is a status row's whole purpose, and on a Codex frame it is the only part
 * that changes between ticks. Arbitrary text is allowed on both sides of the
 * number rather than a fixed shape, because agents pack whatever else they like
 * in beside it — up to and including a second bullet, as Codex does.
 */
const TIMER_HINT =
  /\([^()]*\d+(?:\.\d+)? ?(?:ms|s|m|h|sec|min|hr|second|minute|hour)s?\b[^()]*\)$/i;

/**
 * A row that is *nothing but* a short ellipsised phrase, optionally trailed by
 * one parenthesised hint: `Transmuting…`, `Brewing…`, `Cogitating… (esc to
 * interrupt)`.
 *
 * Claude Code picks a fresh, randomised verb for every spinner frame, so there
 * is no vocabulary to match here — only a shape. The shape is kept narrow on
 * purpose: anchored at both ends so the ellipsis has to end the row, capped at
 * four words, and letters only. That is what separates a spinner label from the
 * two things it could otherwise be confused with — streamed prose trailing off
 * mid-sentence (more words) and code (digits, brackets, operators, quotes).
 */
const DYNAMIC_LABEL =
  /^\p{L}[\p{L}'’-]*(?: \p{L}[\p{L}'’-]*){0,3} ?(?:…|\.\.\.)(?: *\([^()]*\))?$/u;

/**
 * A tool-execution frame: any run of text at all, ellipsised, optionally
 * trailed by one parenthesised hint — `Adding inject()/erase() to the
 * injector…`, `Running tests (esc to interrupt)`.
 *
 * Deliberately the loosest shape in this module. Agents name the work in
 * progress, and the name is whatever the work was about: identifiers, paths,
 * `()`, `/`, digits. {@link DYNAMIC_LABEL}'s letters-only, four-word shape is
 * what rejects those, and it cannot simply be widened — anchored at both ends
 * with an arbitrary middle, this pattern also describes an ordinary markdown
 * bullet trailing off (`* Adding retry logic to the client...`), which is real
 * output and must never be borrowed.
 *
 * So the ellipsis is not what earns trust here; {@link reanchored} is. This
 * shape is only consulted for a row the child rewrote in place, which is the
 * one thing a spinner frame does every ~100ms and streamed prose never does.
 */
const TOOL_LABEL = /^.+(?:…|\.\.\.)(?: *\([^()]*\))?$/u;

/** Rewrites a stream of child output in place. Stateful; feed chunks in order. */
export interface AdInjector {
  /** Map one chunk of child output to the bytes that should reach the terminal. */
  transform(chunk: string): string;
  /**
   * Bytes that paint `ad` on the row the child left the cursor on, or an empty
   * string when the stream is in a state where borrowing that row is unsafe.
   *
   * For the input-driven path: the caller has just seen the user submit a
   * prompt, and the child is about to go quiet. The result must be written to
   * the terminal as-is — the injector's own bookkeeping assumes it was — and the
   * ad stands only until the child's next chunk erases it.
   */
  inject(ad: Ad): string;
  /**
   * Bytes that take a currently-injected ad back down, or an empty string when
   * there is nothing on the row. Unlike {@link flush} this leaves the injector
   * usable, so the caller can retire an ad mid-session.
   */
  erase(): string;
  /**
   * Identifies the ad currently on the status line, or undefined when the row
   * is the child's own again.
   *
   * Every injection — from either path — gets a fresh number, so a caller
   * holding one from earlier can tell "my ad is still up" from "the row has
   * turned over since". That is the question a dwell timer has to answer before
   * it credits an impression.
   */
  injectionId(): number | undefined;
  /** Bytes needed to leave the terminal clean once the child has exited. */
  flush(): string;
}

/**
 * Build an injector that advertises `ad` on `columns`-wide status lines.
 *
 * `columns` bounds the ad text: a sponsored line that wrapped would occupy two
 * rows, and the single-row erase that takes it back down would leave the first
 * one stranded on screen.
 */
export function createAdInjector(ad: Ad, columns: number): AdInjector {
  /** The ad currently on the status line, by {@link AdInjector.injectionId}. */
  let injection: number | undefined;
  /** Distinct per injection for the lifetime of the injector; never reused. */
  let injections = 0;
  /** True while the child owns the alternate screen buffer. */
  let altScreen = false;
  /**
   * True when the last chunk ended mid-escape-sequence, so the terminal is
   * waiting on bytes only the child can supply. Carried between calls because
   * {@link AdInjector.inject} can be reached in that state, and writing there
   * would feed our sequence's bytes into the child's unfinished one.
   */
  let midSequence = false;

  /** Take the row back and hand the ad a fresh identity, in that order. */
  const paint = (copy: Ad, glyph: string | undefined): string => {
    injections += 1;
    injection = injections;
    return `${ERASE_LINE}${sponsoredLine(copy, glyph, columns)}`;
  };

  /** Give the row back to the child, if we are holding it. */
  const unpaint = (): string => {
    if (injection === undefined) return '';
    injection = undefined;
    return ERASE_LINE;
  };

  /**
   * Whether `chunk` is a frame the ad on screen can simply outlive: another
   * repaint of the row we are already holding, and nothing else.
   *
   * Every clause is a way the chunk could be more than that. A line feed means
   * output is being appended below the row; an alt-screen toggle or a cursor
   * move means the child is drawing somewhere we cannot account for; a truncated
   * sequence means this read cannot be trusted at all. Only once all of those
   * are ruled out is the row's own content consulted — and it has to pass the
   * same test that would have earned an injection in the first place, which for
   * the looser shapes includes having been rewritten in place. See "The ad lock".
   */
  const repaintOnly = (chunk: string, scan: AnsiScan): boolean => {
    if (injection === undefined) return false;
    if (scan.truncated || altScreen || scan.altScreen !== undefined) return false;
    if (scan.plain.includes('\n')) return false;
    // Judged over the whole chunk, not just its last line: the paint path can
    // afford to ignore a repaint that finished earlier in the chunk, because it
    // is about to redraw the ad anyway. Holding one already on screen is a
    // stronger claim — that nothing in these bytes disturbed it — so a cursor
    // move anywhere in them hands the row back instead.
    if (hasRepaint(scan.finals)) return false;
    return statusLine(chunk, scan) !== undefined;
  };

  return {
    transform(chunk: string): string {
      const scan = scanAnsi(chunk);
      if (scan.altScreen !== undefined) altScreen = scan.altScreen;
      midSequence = scan.truncated;

      // Another spinner frame under a live ad: drop it on the floor. The ad is
      // already on the row and still correct, and leaving `injection` untouched
      // is what lets a dwell timer recognise it five seconds from now.
      if (repaintOnly(chunk, scan)) return '';

      // Take any previously injected ad back down first, so whatever the child
      // is about to draw starts from the row state it expects.
      const prefix = unpaint();

      if (altScreen || scan.truncated || hasRepaint(scan.lastLineFinals)) return prefix + chunk;

      const status = statusLine(chunk, scan);
      if (status === undefined) return prefix + chunk;

      return `${prefix}${chunk}${paint(ad, status.glyph)}`;
    },

    inject(copy: Ad): string {
      // No disposable row to borrow, or the child owes the terminal the rest of
      // an escape sequence. Either way the prompt goes unmonetised; the output
      // path will pick the next status line up as usual.
      if (altScreen || midSequence) return '';

      // An ad already on this row is replaced rather than stacked, and needs no
      // erase of its own to get out of the way: `paint` leads with the same
      // single-row erase, which is what makes the row reusable in place.
      //
      // No glyph, unlike the output path: the child is not painting a spinner
      // frame for us to borrow one from, and inventing a static one would claim
      // motion that is not there.
      return paint(copy, undefined);
    },

    erase: unpaint,

    injectionId(): number | undefined {
      return injection;
    },

    flush: unpaint,
  };
}

/** What the child left parked on the status line. */
interface StatusLine {
  /** Its spinner glyph, kept so the ad still signals "something is happening". */
  readonly glyph: string | undefined;
}

/**
 * Classify the tail of `chunk` as a status line, or undefined when it is
 * ordinary output that must be left alone.
 */
function statusLine(chunk: string, scan: AnsiScan): StatusLine | undefined {
  // A chunk ending in a line break leaves the cursor on a fresh row: the child
  // has committed that output, so there is nothing disposable to borrow.
  if (chunk.length === 0 || chunk.endsWith('\n') || chunk.endsWith('\r')) return undefined;

  const tail = scan.plain.slice(lastLineStart(scan.plain)).trim();
  if (tail.length === 0) return undefined;

  const head = tail[0] as string;
  if (SPINNER_GLYPHS.includes(head)) return { glyph: head };

  // Peel an ambiguous leading decoration off before matching the wording, but
  // remember it: `* Transmuting…` is a spinner frame, and keeping the `*` lets
  // the ad go on signalling that something is still happening.
  const decorated = WEAK_GLYPHS.includes(head);
  const label = decorated ? tail.slice(1).trim() : tail;
  const glyph = decorated ? head : undefined;
  if (label.length === 0) return undefined;

  if (STRONG_PHRASE.test(label)) return { glyph };
  if (DYNAMIC_LABEL.test(label)) return { glyph };
  if (WEAK_PHRASE.test(label) && (label.endsWith('…') || label.endsWith('...'))) {
    return { glyph };
  }

  // Rows the agent never ellipsised — OpenAI Codex's `• Working (6s • esc to
  // interrupt)`, and the same row once it is down to just `• Working (6s)`. With
  // no ellipsis to mark the row unfinished, two narrower things stand in for it:
  // the wording has to open on a waiting verb, or the row has to carry a live
  // counter, and either way the child has to have drawn the row over whatever was
  // there before. `reanchored` is doing the same job here as it does for tool
  // frames, and for the same reason — `•` heads markdown list items, and an
  // appended one is output the child means to keep however much its wording reads
  // like a spinner.
  if (scan.reanchored && (WAITING_HEAD.test(label) || TIMER_HINT.test(label))) return { glyph };

  // Tool-execution frames, and the loosest shape in the module — so the one that
  // needs the most corroboration around it. Both conditions carry weight:
  // `decorated` is the leading glyph the brief's shape starts from, and
  // `reanchored` is what tells this row apart from the markdown bullet it is
  // otherwise character-for-character identical to. A bullet is appended once
  // and kept; a tool frame is rewritten in place, which is the same premise the
  // borrow rests on.
  if (decorated && scan.reanchored && TOOL_LABEL.test(label)) return { glyph };

  return undefined;
}

/** Index just past the last line break in `text`, i.e. where its final row starts. */
function lastLineStart(text: string): number {
  const lf = text.lastIndexOf('\n');
  const cr = text.lastIndexOf('\r');
  return Math.max(lf, cr) + 1;
}

function hasRepaint(finals: string): boolean {
  for (const final of finals) {
    if (REPAINT_FINALS.includes(final)) return true;
  }
  return false;
}

/** What one pass over a chunk's escape sequences tells us about it. */
interface AnsiScan {
  /** The chunk with every escape sequence removed. */
  readonly plain: string;
  /**
   * The final byte of every CSI sequence in the chunk, in order — the whole-chunk
   * counterpart to {@link lastLineFinals}.
   *
   * Only the ad lock reads this. Deciding whether to *paint* over a row can
   * disregard a repaint that happened earlier in the chunk, since the ad is about
   * to be drawn after those bytes either way. Deciding whether an ad already on
   * screen came through the chunk untouched cannot: a cursor move anywhere in it
   * may have moved the row out from under us.
   */
  readonly finals: string;
  /**
   * The final byte of each CSI sequence on the chunk's *last* line, in order.
   *
   * Scoped that way because the last line is the only row we rewrite, so it is
   * the only row whose repaints can collide with the rewrite. The accumulator
   * resets at every line break — `\n` and `\r` both, since a carriage return
   * restarts the row just as surely as a newline ends it — which leaves it
   * holding exactly the sequences that applied to the row the child parked the
   * cursor on.
   */
  readonly lastLineFinals: string;
  /**
   * Whether the chunk's last row was drawn *over* whatever was there before —
   * begun by a carriage return, or erased with `\x1b[K` — rather than appended
   * after a line feed.
   *
   * This is the tell that separates a status line from prose that merely looks
   * like one. A spinner frame exists to be replaced: the child rewinds to column
   * 0 and repaints the same row every ~100ms, which is the same disposability
   * this module relies on to borrow it. Streamed output has no reason to rewind —
   * it appends, and a bullet or a sentence trailing off at a chunk boundary is
   * text the child means to keep.
   *
   * Scoped to the last row for the same reason as {@link lastLineFinals}: an
   * in-place rewrite three rows up says nothing about the row we would borrow.
   */
  readonly reanchored: boolean;
  /** Set when the chunk toggled the alternate screen buffer; last toggle wins. */
  readonly altScreen: boolean | undefined;
  /** An escape sequence ran off the end of the chunk, so this read is inconclusive. */
  readonly truncated: boolean;
}

/**
 * Walk `text` once, separating visible characters from escape sequences.
 *
 * The tokenizer is shared with the reserved-row strategy (`ansi-scan.ts`), which
 * needs the same parse for a different reason — it rewrites particular sequences
 * rather than summarising them. What this function adds is the summary: which CSI
 * commands were used on the final row, whether that row was drawn over what was
 * there before, and whether the chunk was cut mid-sequence.
 */
function scanAnsi(text: string): AnsiScan {
  const { tokens, truncated } = tokenizeAnsi(text);
  let plain = '';
  let finals = '';
  let lastLineFinals = '';
  let reanchored = false;
  let altScreen: boolean | undefined;

  for (const token of tokens) {
    if (token.kind === 'text') {
      for (const char of token.raw) {
        plain += char;
        if (char !== '\n' && char !== '\r') continue;
        // A new row starts here, so nothing above it can bear on the rewrite.
        lastLineFinals = '';
        // A line feed opens a row below the last one; a carriage return rewinds
        // to the start of the row already there, which is a rewrite of it. `\r\n`
        // is both in that order, and ends up correctly counted as the line feed.
        reanchored = char === '\r';
      }
      continue;
    }

    // OSC (window titles, hyperlinks) and the two-byte escapes carry nothing
    // this summary reads. An OSC payload especially: it is human-readable text
    // that would otherwise pollute `plain` and read as a status line.
    if (token.kind !== 'csi') continue;

    finals += token.final;
    lastLineFinals += token.final;
    // Erasing the row is a rewrite of it, the same as rewinding to column 0 —
    // and it is how an agent that repaints without a `\r` clears the old frame.
    if (token.final === 'K') reanchored = true;
    if (ALT_SCREEN_MODES.has(token.params) && (token.final === 'h' || token.final === 'l')) {
      altScreen = token.final === 'h';
    }
  }

  return {
    plain,
    finals,
    lastLineFinals,
    reanchored,
    altScreen,
    truncated: truncated.length > 0,
  };
}
