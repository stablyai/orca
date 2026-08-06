import type { Terminal } from '@xterm/xterm'

type ArabicShapingTerminal = Pick<Terminal, 'registerCharacterJoiner' | 'deregisterCharacterJoiner'>

type LazyArabicShapingJoinerState = {
  cleanup: (() => void) | null
  isShapingActive: () => boolean
  registrationAttempted: boolean
  trailingHighSurrogate: string
}

const lazyArabicShapingJoinerByTerminal = new WeakMap<
  ArabicShapingTerminal,
  LazyArabicShapingJoinerState
>()

// Why: xterm lacks BiDi/shaping (xterm.js#701, Orca #5262); joining each RTL run into one cell lets the browser shape and reorder it.

// Every strong-RTL block sits at/above U+0590, so ASCII/Latin bails out with a single charCodeAt sweep.
const RTL_SCAN_FLOOR = 0x0590

export function isStrongRtlCodePoint(codePoint: number): boolean {
  return (
    // One contiguous strong-RTL span (Hebrew through Arabic Extended-A).
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

function containsStrongRtlText(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    if (unit < RTL_SCAN_FLOOR) {
      continue
    }
    let codePoint = unit
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = (unit - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000
        index++
      }
    }
    if (isStrongRtlCodePoint(codePoint)) {
      return true
    }
  }
  return false
}

// Neutrals may sit inside a run but never open/close it; ASCII letters break runs so paths like test.txt aren't pulled in.
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

// Run-transparent format controls: breaking on them would split a word, or open an empty joined range that blanks a glyph.
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

// Why: opening a run at a combining mark (renders in its base cell) makes an empty joined range that blanks a glyph in WebGL.
const COMBINING_MARK = /\p{Mn}/u
function canOpenRtlRun(codePoint: number): boolean {
  return !COMBINING_MARK.test(String.fromCodePoint(codePoint))
}

/**
 * Character-joiner handler for xterm's registerCharacterJoiner API: returns the
 * [start, end) ranges of a row segment that should render as joined units. A run
 * spans the first to last strong-RTL code point, tunneling neutrals; runs of
 * fewer than two RTL code points are skipped (isolated forms already render).
 *
 * Known xterm limitations: a standalone width-0 cell (e.g. RLM at line start)
 * shifts the run's cell range by one; and the WebGL renderer un-joins for
 * cursor/selection but not decorations, so a search-match highlight inside a run
 * renders all-or-nothing.
 */
export function findRtlJoinRanges(text: string): [number, number][] {
  const length = text.length
  let i = 0
  for (; i < length; i++) {
    if (text.charCodeAt(i) >= RTL_SCAN_FLOOR) {
      break
    }
  }
  // Why: xterm merges other joiners' results into this array in place, so it must be freshly allocated each call.
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
      // Non-RTL above the floor (box drawing, CJK, emoji) breaks the run so TUI borders and CJK keep per-cell rendering.
      closeRun()
    }
    i += codeUnitLength - 1
  }
  closeRun()
  return ranges
}

/** Register the RTL shaping joiner; returns a cleanup deregistering it — Terminal.dispose() leaks joiners (xtermjs/xterm.js#3289). */
export function registerArabicShapingJoiner(
  terminal: ArabicShapingTerminal,
  isShapingActive: () => boolean
): () => void {
  // Why: DOM renderer letter-spacing breaks grid alignment for joined runs, so join only while WebGL is the live renderer.
  const joinerId = terminal.registerCharacterJoiner((text) =>
    isShapingActive() ? findRtlJoinRanges(text) : []
  )
  return () => {
    terminal.deregisterCharacterJoiner(joinerId)
  }
}

/** Configure lazy RTL shaping; defer joiner registration since any joiner makes xterm rescan every cell each repaint. */
export function configureLazyArabicShapingJoiner(
  terminal: ArabicShapingTerminal,
  isShapingActive: () => boolean
): () => void {
  const previousState = lazyArabicShapingJoinerByTerminal.get(terminal)
  try {
    previousState?.cleanup?.()
  } catch {
    // A disposed terminal can reject deregistration; replace stale state anyway.
  }

  const state: LazyArabicShapingJoinerState = {
    cleanup: null,
    isShapingActive,
    registrationAttempted: false,
    trailingHighSurrogate: ''
  }
  lazyArabicShapingJoinerByTerminal.set(terminal, state)

  return () => {
    if (lazyArabicShapingJoinerByTerminal.get(terminal) !== state) {
      return
    }
    try {
      state.cleanup?.()
    } catch {
      // Pane teardown must continue if xterm disposed before deregistration.
    } finally {
      lazyArabicShapingJoinerByTerminal.delete(terminal)
    }
  }
}

/** Register the configured joiner immediately before the first RTL write. */
export function ensureArabicShapingJoinerForText(
  terminal: ArabicShapingTerminal,
  text: string
): void {
  const state = lazyArabicShapingJoinerByTerminal.get(terminal)
  if (!state || state.cleanup || state.registrationAttempted) {
    return
  }

  // Why: PTY/replay chunks can split a supplementary-plane RTL code point across surrogate halves; keep the boundary unit.
  const scanText = state.trailingHighSurrogate + text
  const finalCharacter = scanText.at(-1) ?? ''
  const finalCodeUnit = finalCharacter.charCodeAt(0)
  state.trailingHighSurrogate =
    finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff ? finalCharacter : ''
  if (!containsStrongRtlText(scanText)) {
    return
  }

  state.trailingHighSurrogate = ''
  state.registrationAttempted = true
  try {
    state.cleanup = registerArabicShapingJoiner(terminal, state.isShapingActive)
  } catch {
    // Why: shaping is optional; swallow a registration race with pane disposal rather than drop bytes.
  }
}
