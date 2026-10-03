import type { IUnicodeHandling, IUnicodeVersionProvider } from '@xterm/xterm'
import {
  isEmojiModifier,
  isEmojiModifierBase,
  isEmojiPresentationWideCodepoint,
  isEmojiVariationSequenceBase
} from './terminal-emoji-width-ranges'

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
const EMOJI_PRESENTATION_SELECTOR = 0xfe0f

function extractWidth(properties: number): 0 | 1 | 2 {
  return ((properties >> 1) & 3) as 0 | 1 | 2
}

function extractCharKind(properties: number): number {
  return properties >> 3
}

function extractShouldJoin(properties: number): boolean {
  return (properties & 1) === 1
}

function createProperties(charKind: number, width: 0 | 1 | 2, shouldJoin: boolean): number {
  return ((charKind & 0xffffff) << 3) | ((width & 3) << 1) | (shouldJoin ? 1 : 0)
}

/**
 * Orca's single authority for how many cells a grapheme cluster occupies.
 *
 * Every terminal Orca runs activates this provider, so the live pane, the
 * headless daemon mirror the snapshot/restore path serializes from, and the
 * dashboard preview budget columns identically. The rules below exist because
 * xterm's Unicode 11 tables measure single code points against a table frozen
 * in 2018, while the TUIs writing into the pane measure whole clusters against
 * a current one — and every cell of disagreement shifts the columns an in-place
 * redraw erases and reprints.
 *
 * Not implemented: U+FE0E text presentation, which would have to narrow an
 * already-placed cluster. xterm's printer only ever advances the cursor for a
 * joined code point, so a narrowing cluster would leave the cell width and the
 * cursor disagreeing.
 */
class OrcaUnicodeProvider implements IUnicodeVersionProvider {
  public readonly version = ORCA_UNICODE_VERSION

  public constructor(private readonly baseProvider: IUnicodeVersionProvider) {}

  public wcwidth(codepoint: number): 0 | 1 | 2 {
    if (isEmojiPresentationWideCodepoint(codepoint)) {
      return 2
    }
    return this.baseProvider.wcwidth(codepoint)
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

    if (
      codepoint === EMOJI_PRESENTATION_SELECTOR &&
      precedingWidth === 1 &&
      isEmojiVariationSequenceBase(precedingKind)
    ) {
      // Why: U+FE0F switches its base to emoji presentation, which every other
      // terminal advances two cells for; xterm keeps the text-presentation cell.
      return createProperties(codepoint, 2, true)
    }

    if (isEmojiModifier(codepoint) && precedingWidth === 2 && isEmojiModifierBase(precedingKind)) {
      // Why: a skin-tone modifier belongs to its base's cluster. Left to the v11
      // table it lands as a second wide cell and every later column shifts by two.
      // Why gated on the base: a modifier after any other wide cell — a CJK
      // ideograph, an emoji that takes no skin tone — is not a modifier sequence,
      // and joining it there would narrow text this provider never measured.
      return createProperties(codepoint, 2, true)
    }

    const base = this.baseProvider.charProperties(codepoint, preceding)
    const shouldJoin = extractShouldJoin(base)
    const baseWidth = extractWidth(base)
    // Why re-encode: the base provider reports char kind 0 and derives width
    // from its own wcwidth, so the rules above would lose both the preceding
    // code point and this provider's post-Unicode-11 widths. A joining code
    // point keeps the cluster width the base already resolved.
    const width = shouldJoin || !isEmojiPresentationWideCodepoint(codepoint) ? baseWidth : 2
    return createProperties(codepoint, width, shouldJoin)
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
