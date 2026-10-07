/**
 * Terminal string primitives shared by the pre-spawn banner and the live
 * injector: making ad text safe to print, and making it clickable.
 *
 * Both concerns belong together because they are two halves of the same
 * problem. Ad copy is attacker-controlled text that we write straight to a
 * developer's terminal, and a terminal is an interpreter: bytes in the payload
 * are commands, not just characters. So the payload is stripped of everything
 * the terminal would *act* on (`sanitizeAdText`), and the only escape sequence
 * we then add around it is one we construct ourselves (`hyperlink`).
 */

const ESC = '\u001B';

/** String Terminator (`ESC \`), the sequence that closes an OSC. */
const ST = `${ESC}\\`;

/**
 * C0 controls that carry word separation: tab, line feed, vertical tab, form
 * feed, carriage return. Folded to a single space rather than deleted, because
 * deleting them welds words together (`Ship faster<LF>Today` would become
 * `Ship fasterToday`).
 *
 * Tab is folded rather than kept, even though it is harmless on its own. Both
 * the banner and the injected line are single rows, and the injector's clip
 * assumes one column per character; a tab rendering as up to eight columns can
 * wrap the row, and a wrapped ad survives the injector's single-row erase as a
 * stranded line on screen.
 */
const SEPARATOR_CONTROLS = /[\t\n\v\f\r]/g;

/**
 * Everything the terminal would interpret as a command rather than display:
 * the remaining C0 range, DEL, and the C1 range.
 *
 * C0 is the headline vulnerability — `ESC` opens any escape sequence at all, so
 * an ad reading `ESC [ 2 J` clears the developer's screen and `BEL` rings their
 * bell. C1 is included because it is the same attack one encoding away: a UTF-8
 * terminal decodes `U+009B` to 8-bit CSI and `U+009D` to 8-bit OSC, so
 * stripping only C0 would leave an equivalent hole open.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNSAFE_CONTROLS = /[\u0000-\u001F\u007F-\u009F]/g;

/** Runs left behind once controls have been folded and stripped. */
const REPEATED_SPACES = / {2,}/g;

/**
 * Control characters plus every character no URL may legitimately contain
 * unencoded — the whole range up to and including space.
 *
 * A URL is the sharper of the two injection sites: it goes *inside* an OSC 8
 * sequence, so a `BEL` or `ESC \` in the payload closes our sequence early and
 * hands the terminal whatever follows as top-level input.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const UNSAFE_IN_URL = /[\u0000-\u0020\u007F-\u009F]/g;

/**
 * Schemes that may be turned into a clickable link. Deliberately an allowlist:
 * a terminal that follows an OSC 8 link hands the URL to the OS, so a `file:`
 * or `javascript:` destination smuggled through the ad server would be one
 * click away from acting on the developer's machine.
 */
const LINKABLE_SCHEME = /^https?:\/\/\S/i;

/**
 * Make advertiser-supplied copy safe to write to a terminal, preserving only
 * what it can display. May return an empty string, which callers should treat
 * as "there is no ad here".
 */
export function sanitizeAdText(text: string): string {
  return text
    .replace(SEPARATOR_CONTROLS, ' ')
    .replace(UNSAFE_CONTROLS, '')
    .replace(REPEATED_SPACES, ' ')
    .trim();
}

/**
 * Make an advertiser-supplied URL safe to embed in an OSC 8 sequence. The
 * result is not guaranteed to be a *valid* URL — `hyperlink` decides that —
 * only that it cannot break out of the sequence carrying it.
 */
export function sanitizeAdUrl(url: string): string {
  return url.replace(UNSAFE_IN_URL, '');
}

/**
 * Wrap `text` in an OSC 8 hyperlink pointing at `url`:
 * `ESC ] 8 ; ; <url> ST <text> ESC ] 8 ; ; ST`.
 *
 * Modern terminals (iTerm2, VS Code, Kitty, WezTerm, recent GNOME Terminal)
 * render `text` as clickable and show nothing of the sequence itself. Older
 * ones parse the OSC, find a command they do not implement, and discard it — so
 * `text` still prints exactly as it would have unlinked. Both halves are
 * emitted here rather than left to callers, so the link is always closed and
 * its attribute can never leak onto the child's own output.
 *
 * `text` is returned unlinked rather than linked-but-inert when `url` is not an
 * `http(s)` destination, so a caller can always print the result without
 * checking anything first.
 */
export function hyperlink(url: string, text: string): string {
  if (!LINKABLE_SCHEME.test(url)) return text;
  return `${ESC}]8;;${url}${ST}${text}${ESC}]8;;${ST}`;
}
