import type { IUnicodeHandling, IUnicodeVersionProvider } from '@xterm/xterm'

type XtermTerminalWithUnicodeCore = {
  unicode: IUnicodeHandling
  _core?: {
    unicodeService?: {
      _providers?: Record<string, IUnicodeVersionProvider>
    }
  }
}

const ORCA_UNICODE_VERSION = 'orca-11-zwj'
const UNICODE11_VERSION = '11'
const ZERO_WIDTH_JOINER = 0x200d

// East_Asian_Width=Ambiguous enclosed glyphs (①, 🄰…) that unicode11 budgets as
// one cell though fonts draw them full-width, so ①-before-ASCII overlaps.
// Regenerate: EastAsianWidth.txt category A ∩ unicode11 wcwidth==1 over blocks
// U+2460–24FF, U+3200–32FF, U+1F100–1F1FF, U+1F200–1F2FF (last yields none);
// pinned to Unicode 17.0.0. Sorted, non-overlapping, inclusive ranges.
const ENCLOSED_AMBIGUOUS_WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x2460, 0x24e9],
  [0x24eb, 0x24ff],
  [0x3248, 0x324f],
  [0x1f100, 0x1f10a],
  [0x1f110, 0x1f12d],
  [0x1f130, 0x1f169],
  [0x1f170, 0x1f18d],
  [0x1f18f, 0x1f190],
  [0x1f19b, 0x1f1ac]
]

function isEnclosedAmbiguousWide(codepoint: number): boolean {
  let low = 0
  let high = ENCLOSED_AMBIGUOUS_WIDE_RANGES.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const [start, end] = ENCLOSED_AMBIGUOUS_WIDE_RANGES[mid]
    if (codepoint < start) {
      high = mid - 1
    } else if (codepoint > end) {
      low = mid + 1
    } else {
      return true
    }
  }
  return false
}

function extractWidth(properties: number): 0 | 1 | 2 {
  return ((properties >> 1) & 3) as 0 | 1 | 2
}

function extractCharKind(properties: number): number {
  return properties >> 3
}

function createProperties(charKind: number, width: 0 | 1 | 2, shouldJoin: boolean): number {
  return ((charKind & 0xffffff) << 3) | ((width & 3) << 1) | (shouldJoin ? 1 : 0)
}

class OrcaUnicodeProvider implements IUnicodeVersionProvider {
  public readonly version = ORCA_UNICODE_VERSION

  public constructor(private readonly baseProvider: IUnicodeVersionProvider) {}

  public wcwidth(codepoint: number): 0 | 1 | 2 {
    const base = this.baseProvider.wcwidth(codepoint)
    if (base === 1 && isEnclosedAmbiguousWide(codepoint)) {
      return 2
    }
    return base
  }

  public charProperties(codepoint: number, preceding: number): number {
    const precedingWidth = extractWidth(preceding)
    const precedingKind = extractCharKind(preceding)

    if (codepoint === ZERO_WIDTH_JOINER && precedingWidth > 0) {
      return createProperties(ZERO_WIDTH_JOINER, precedingWidth, true)
    }

    if (precedingKind === ZERO_WIDTH_JOINER && precedingWidth > 0 && this.wcwidth(codepoint) > 0) {
      // Why: CLIs render ZWJ emoji as one visible glyph and budget them as one
      // wide cell pair; xterm Unicode11 otherwise advances for both emoji parts.
      return createProperties(codepoint, precedingWidth, true)
    }

    const properties = this.baseProvider.charProperties(codepoint, preceding)
    // Why: xterm lays out cells from charProperties, not wcwidth, so an enclosed
    // ambiguous glyph must be widened here too. Only bump the specific narrow
    // enclosed code points; never touch the combining/join widths the base set.
    if (extractWidth(properties) === 1 && isEnclosedAmbiguousWide(codepoint)) {
      return createProperties(extractCharKind(properties), 2, Boolean(properties & 1))
    }
    return properties
  }
}

export function activateOrcaTerminalUnicodeProvider(terminal: XtermTerminalWithUnicodeCore): void {
  const { unicode } = terminal
  if (unicode.activeVersion === ORCA_UNICODE_VERSION) {
    return
  }

  const baseProvider = terminal._core?.unicodeService?._providers?.[UNICODE11_VERSION]
  if (!baseProvider) {
    unicode.activeVersion = UNICODE11_VERSION
    return
  }

  if (!unicode.versions.includes(ORCA_UNICODE_VERSION)) {
    unicode.register(new OrcaUnicodeProvider(baseProvider))
  }
  unicode.activeVersion = ORCA_UNICODE_VERSION
}
