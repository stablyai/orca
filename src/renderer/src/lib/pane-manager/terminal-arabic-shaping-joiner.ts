import type { Terminal } from '@xterm/xterm'

// Why: xterm draws every cell's glyph in isolation, so Arabic output shows
// disconnected letterforms in logical (reversed) order — upstream has no
// BiDi/shaping support (xtermjs/xterm.js#701, Orca #5262). Joining each RTL
// run into one cell range makes both renderers (WebGL atlas, DOM row factory)
// draw the run as a single string, letting the browser apply contextual
// shaping and BiDi ordering inside the run's grid-aligned cell box. The
// terminal buffer and PTY stream are untouched, and xterm itself un-joins any
// range that holds the cursor or a partially selected span, so cursor
// visibility and selection stay cell-accurate.

// Every strong-RTL script block sits at or above U+0590, so plain ASCII/Latin
// segments bail out with a single charCodeAt sweep and no per-char decode.
const RTL_SCAN_FLOOR = 0x0590

export function isStrongRtlCodePoint(codePoint: number): boolean {
  return (
    // Hebrew, Arabic, Syriac, Arabic Sup, Thaana, NKo, Samaritan, Mandaic,
    // Syriac Sup, Arabic Extended-B/A — one contiguous strong-RTL span.
    (codePoint >= 0x0590 && codePoint <= 0x08ff) ||
    // Hebrew + Arabic presentation forms (legacy shaped codepoints).
    (codePoint >= 0xfb1d && codePoint <= 0xfdff) ||
    (codePoint >= 0xfe70 && codePoint <= 0xfeff) ||
    // Historic RTL scripts (Phoenician, Nabataean, …).
    (codePoint >= 0x10800 && codePoint <= 0x10fff) ||
    // Mende Kikakui, Adlam, Arabic Mathematical symbols.
    (codePoint >= 0x1e800 && codePoint <= 0x1eeff)
  )
}

// Neutral characters may sit inside an RTL run (so a multi-word phrase joins
// as one unit and keeps right-to-left word order) but never start or end one:
// ASCII space/digits/punctuation and NBSP. ASCII letters are strong LTR and
// always break a run so paths like `test.txt` never get pulled into one.
function isRunNeutralCharCode(charCode: number): boolean {
  if (charCode < 0x20) {
    return false
  }
  if (charCode <= 0x7e) {
    const isAsciiLetter =
      (charCode >= 0x41 && charCode <= 0x5a) || (charCode >= 0x61 && charCode <= 0x7a)
    return !isAsciiLetter
  }
  return charCode === 0xa0
}

// ZWNJ/ZWJ shape within a word (mandatory in Persian/Kurdish orthography) and
// RLM/ALM assert RTL context — breaking the run on them would split one word
// into two joined chunks laid out in swapped visual order. Transparent: never
// opens, closes, extends, or counts toward a run. LRM (U+200E) is strong LTR
// and intentionally still breaks the run.
// The zero-width Cf controls inside the RTL blocks (Arabic number signs
// U+0600–0605, end of ayah U+06DD, Syriac abbreviation mark U+070F, disputed
// end of ayah U+08E2) and BOM/ZWNBSP U+FEFF are width-0 in xterm, so like
// combining marks they must never open or count a run (an empty joined cell
// range blanks the following glyph in WebGL) — and they have no shape to join.
function isRtlRunTransparentCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    codePoint === 0x200f ||
    codePoint === 0x061c ||
    (codePoint >= 0x0600 && codePoint <= 0x0605) ||
    codePoint === 0x06dd ||
    codePoint === 0x070f ||
    codePoint === 0x08e2 ||
    codePoint === 0xfeff
  )
}

// Why: a combining mark renders inside its base's cell, so a run opened at a
// mark starts mid-cell — xterm rounds that to an empty joined cell range and
// the WebGL renderer then draws an empty glyph over the next character. Marks
// may extend and count only after a spacing RTL letter opened the run.
const COMBINING_MARK = /\p{Mn}/u
function canOpenRtlRun(codePoint: number): boolean {
  return !COMBINING_MARK.test(String.fromCodePoint(codePoint))
}

/**
 * Character-joiner handler for xterm's registerCharacterJoiner API. Receives
 * one attribute-homogeneous segment of a row and returns [start, end) string
 * ranges that should render as single joined units.
 *
 * A run spans from the first strong-RTL code point to the last one of a
 * cluster, tunneling through neutral characters between RTL words. Runs with
 * fewer than two RTL code points are skipped: an isolated Arabic letter
 * already renders in its correct (isolated) form cell-by-cell.
 *
 * Known upstream limitation (affects every joiner, ligatures too): a
 * standalone width-0 cell (e.g. RLM at line start) makes xterm's
 * CharacterJoinerService skip the cell without advancing its string index,
 * shifting the run's cell range by one — fix belongs upstream in xterm.js.
 *
 * Known upstream limitation #2: the WebGL renderer un-joins a range for the
 * cursor or a partial selection but not for decorations, so a search-match
 * highlight inside a joined run renders all-or-nothing — the whole run when
 * the match covers the run's first cell, otherwise not at all. Same class as
 * ligatures today, extended here to phrase-length runs.
 */
export function findRtlJoinRanges(text: string): [number, number][] {
  const length = text.length
  let i = 0
  for (; i < length; i++) {
    if (text.charCodeAt(i) >= RTL_SCAN_FLOOR) {
      break
    }
  }
  // Why: xterm merges other joiners' results into the returned array in
  // place, so this must be a fresh array on every call — never a shared
  // constant. The non-RTL fast path above keeps the allocation the only cost.
  const ranges: [number, number][] = []
  if (i === length) {
    return ranges
  }

  let runStart = -1
  let runEnd = -1
  let runRtlCount = 0
  const closeRun = (): void => {
    if (runStart !== -1 && runRtlCount >= 2) {
      ranges.push([runStart, runEnd])
    }
    runStart = -1
    runRtlCount = 0
  }

  for (; i < length; i++) {
    const unit = text.charCodeAt(i)
    if (unit < RTL_SCAN_FLOOR) {
      if (runStart !== -1 && !isRunNeutralCharCode(unit)) {
        closeRun()
      }
      continue
    }
    let codePoint = unit
    let codeUnitLength = 1
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < length) {
      const low = text.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = (unit - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000
        codeUnitLength = 2
      }
    }
    if (isRtlRunTransparentCodePoint(codePoint)) {
      // Run-transparent format controls: skip without opening or closing.
    } else if (isStrongRtlCodePoint(codePoint)) {
      if (runStart !== -1 || canOpenRtlRun(codePoint)) {
        if (runStart === -1) {
          runStart = i
        }
        runEnd = i + codeUnitLength
        runRtlCount++
      }
    } else if (runStart !== -1) {
      // Non-RTL above the floor (box drawing, CJK, emoji, …) breaks the run
      // so TUI borders and East Asian text keep per-cell rendering.
      closeRun()
    }
    i += codeUnitLength - 1
  }
  closeRun()
  return ranges
}

/** Register the RTL shaping joiner on a terminal. Returns a cleanup that
 *  deregisters the joiner — `Terminal.dispose()` does not remove registered
 *  character joiners, so disposePane() must call this to avoid leaking the
 *  registration (xtermjs/xterm.js#3289). */
export function registerArabicShapingJoiner(
  terminal: Pick<Terminal, 'registerCharacterJoiner' | 'deregisterCharacterJoiner'>,
  isShapingActive: () => boolean
): () => void {
  // Why: the DOM renderer sizes a joined span with one letter-spacing value
  // that the browser applies after every character, so a joined run whose
  // shaped width differs from its cell budget blows out the whole row's grid
  // alignment. Join only while the WebGL renderer is live (checked per render
  // call, so context-loss/GPU-setting fallbacks revert to per-cell rendering
  // on their own refresh); DOM-rendered panes keep xterm's unshaped default.
  const joinerId = terminal.registerCharacterJoiner((text) =>
    isShapingActive() ? findRtlJoinRanges(text) : []
  )
  return () => {
    terminal.deregisterCharacterJoiner(joinerId)
  }
}
