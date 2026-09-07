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
const VARIATION_SELECTOR_16 = 0xfe0f
const EMOJI_PRESENTATION_WIDTH = 2
const KEYCAP_NUMBER_SIGN = 0x23
const KEYCAP_ASTERISK = 0x2a
const KEYCAP_DIGIT_FIRST = 0x30
const KEYCAP_DIGIT_LAST = 0x39
/** U+00A9 COPYRIGHT SIGN, the lowest code point carrying the Emoji property. */
const LOWEST_EMOJI_BASE = 0xa9

/**
 * Bases a VS16 can legitimately switch to emoji presentation: the keycap bases
 * plus everything at or above the first Emoji code point. Deliberately coarser
 * than the Emoji property table, which would have to be embedded and kept in
 * step with each Unicode release; what it has to exclude is Latin text, where a
 * trailing VS16 is malformed rather than a presentation request.
 */
function acceptsEmojiPresentation(codepoint: number): boolean {
  return (
    codepoint === KEYCAP_NUMBER_SIGN ||
    codepoint === KEYCAP_ASTERISK ||
    (codepoint >= KEYCAP_DIGIT_FIRST && codepoint <= KEYCAP_DIGIT_LAST) ||
    codepoint >= LOWEST_EMOJI_BASE
  )
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
    return this.baseProvider.wcwidth(codepoint)
  }

  public charProperties(codepoint: number, preceding: number): number {
    const precedingWidth = extractWidth(preceding)
    const precedingKind = extractCharKind(preceding)

    if (codepoint === ZERO_WIDTH_JOINER && precedingWidth > 0) {
      return createProperties(ZERO_WIDTH_JOINER, precedingWidth, true)
    }

    if (
      codepoint === VARIATION_SELECTOR_16 &&
      precedingWidth > 0 &&
      acceptsEmojiPresentation(precedingKind)
    ) {
      // Why: VS16 requests the emoji presentation of a text-default base, which
      // other terminals advance two cells for; xterm keeps the base's text width,
      // so TUIs budgeting two cells lose their column alignment.
      return createProperties(VARIATION_SELECTOR_16, EMOJI_PRESENTATION_WIDTH, true)
    }

    if (precedingKind === ZERO_WIDTH_JOINER && precedingWidth > 0 && this.wcwidth(codepoint) > 0) {
      // Why: CLIs render ZWJ emoji as one visible glyph and budget them as one
      // wide cell pair; xterm Unicode11 otherwise advances for both emoji parts.
      return createProperties(codepoint, precedingWidth, true)
    }

    const properties = this.baseProvider.charProperties(codepoint, preceding)
    // Why: xterm leaves the char kind at 0, so the code point a VS16 arrives
    // after would otherwise be unknowable. Record it without touching width.
    return createProperties(codepoint, extractWidth(properties), (properties & 1) === 1)
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
