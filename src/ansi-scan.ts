/**
 * One ANSI tokenizer, shared by both interception strategies.
 *
 * A chunk arriving off a pty master is arbitrary bytes cut at an arbitrary
 * point: an escape sequence can straddle two reads, and half a sequence is
 * indistinguishable from a complete one unless the split is tracked explicitly.
 * Every decision either strategy makes rests on that — `injector.ts` refuses to
 * touch a row when the child owes the terminal the rest of a sequence, and
 * `reserved-row.ts` has to *rewrite* particular sequences, which it can only do
 * once it knows where each one starts and ends.
 *
 * So the parse is one pass that yields tokens rather than a summary, and the
 * bytes that ran off the end of the chunk are reported separately
 * ({@link AnsiTokens.truncated}) instead of being guessed at. What each caller
 * does with a truncated tail differs — the injector treats the read as
 * inconclusive, the reserved row carries the tail into the next chunk — but
 * neither can decide that without being told.
 *
 * Hand-rolled rather than regex-based for the same reason: a regex that
 * half-matches a sequence cut at a chunk boundary is worse than no match at all.
 */

const ESC = '\u001B';

/** Bell, the legacy OSC terminator. */
const BEL = '\u0007';

/**
 * One lexical unit of a child's output stream.
 *
 * `text` is everything the terminal would display (plus the C0 controls that
 * position the cursor within a row, `\n` and `\r`, which callers inspect
 * themselves). The other three are the sequences the terminal *acts* on, kept
 * verbatim in `raw` so a caller can re-emit a token it does not care about
 * byte-for-byte.
 */
export type AnsiToken =
  | { readonly kind: 'text'; readonly raw: string }
  /** `ESC [ <params> <final>` — the sequences that move, erase, and colour. */
  | {
      readonly kind: 'csi';
      readonly raw: string;
      /** Everything between `[` and the final byte: `1;40`, `?1049`, `` (empty). */
      readonly params: string;
      /** The byte in `0x40`–`0x7E` that ended the sequence: `H`, `K`, `r`, `h`. */
      readonly final: string;
    }
  /** `ESC ] … BEL` or `ESC ] … ESC \` — window titles, hyperlinks. */
  | { readonly kind: 'osc'; readonly raw: string }
  /** A two-byte escape we do not interpret: `ESC 7`, `ESC M`, `ESC =`. */
  | { readonly kind: 'escape'; readonly raw: string };

export interface AnsiTokens {
  readonly tokens: readonly AnsiToken[];
  /**
   * The trailing bytes of an escape sequence that ran off the end of the chunk,
   * or an empty string when the chunk ended cleanly.
   *
   * Never included in `tokens`: they cannot be classified yet, and acting on a
   * guess is exactly the corruption this module exists to prevent.
   */
  readonly truncated: string;
}

/** Split `text` into displayable runs and the escape sequences between them. */
export function tokenizeAnsi(text: string): AnsiTokens {
  const tokens: AnsiToken[] = [];
  /** Start of the displayable run currently being accumulated. */
  let textStart = 0;
  let index = 0;

  const flushText = (end: number): void => {
    if (end > textStart) tokens.push({ kind: 'text', raw: text.slice(textStart, end) });
  };

  const truncate = (from: number): AnsiTokens => {
    flushText(from);
    return { tokens, truncated: text.slice(from) };
  };

  while (index < text.length) {
    if (text[index] !== ESC) {
      index += 1;
      continue;
    }

    const start = index;
    const introducer = text[start + 1];
    // `ESC` as the very last byte: the sequence has not begun yet.
    if (introducer === undefined) return truncate(start);

    if (introducer === ']') {
      const end = oscEnd(text, start + 2);
      if (end === undefined) return truncate(start);
      flushText(start);
      tokens.push({ kind: 'osc', raw: text.slice(start, end) });
      textStart = end;
      index = end;
      continue;
    }

    // Anything that is not CSI is a two-byte escape we pass through untouched.
    // Deliberately not a full parse of the intermediate-byte forms (`ESC ( B`):
    // neither strategy interprets them, and consuming two bytes leaves the rest
    // as ordinary text, which is what both have always assumed.
    if (introducer !== '[') {
      flushText(start);
      tokens.push({ kind: 'escape', raw: text.slice(start, start + 2) });
      textStart = start + 2;
      index = start + 2;
      continue;
    }

    let cursor = start + 2;
    while (cursor < text.length && !isFinalByte(text[cursor] as string)) cursor += 1;
    if (cursor >= text.length) return truncate(start);

    flushText(start);
    tokens.push({
      kind: 'csi',
      raw: text.slice(start, cursor + 1),
      params: text.slice(start + 2, cursor),
      final: text[cursor] as string,
    });
    textStart = cursor + 1;
    index = cursor + 1;
  }

  flushText(text.length);
  return { tokens, truncated: '' };
}

/** Index just past an OSC terminator (BEL or `ESC \`), or undefined if unterminated. */
function oscEnd(text: string, from: number): number | undefined {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === BEL) return index + 1;
    if (text[index] === ESC) {
      // `ESC` inside an OSC is either the start of `ESC \` or, if it is the last
      // byte we have, a terminator we cannot yet see the whole of.
      if (text[index + 1] === undefined) return undefined;
      return text[index + 1] === '\\' ? index + 2 : undefined;
    }
  }
  return undefined;
}

/** CSI sequences end on the first byte in `0x40`–`0x7E`. */
export function isFinalByte(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}
