import type { IUnicodeHandling, IUnicodeVersionProvider } from '@xterm/xterm'
import {
  resolveEastAsianAmbiguousCellWidth,
  type TerminalEastAsianAmbiguousWidth
} from './east-asian-ambiguous-width'

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

// Why: settings can change after the provider is registered; read mode at
// measurement time so new cells honor the toggle without re-registering.
let eastAsianAmbiguousWidthMode: TerminalEastAsianAmbiguousWidth = 'narrow'

export function getTerminalEastAsianAmbiguousWidthMode(): TerminalEastAsianAmbiguousWidth {
  return eastAsianAmbiguousWidthMode
}

export function setTerminalEastAsianAmbiguousWidthMode(
  mode: TerminalEastAsianAmbiguousWidth | null | undefined
): void {
  eastAsianAmbiguousWidthMode = mode === 'wide' ? 'wide' : 'narrow'
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

// Why: plain object provider (not a class with field decls) so the mobile WebView
// engine esbuild (Chrome 74 / ES2019 floor) never emits class-field syntax (#9958).
function createOrcaUnicodeProvider(baseProvider: IUnicodeVersionProvider): IUnicodeVersionProvider {
  return {
    version: ORCA_UNICODE_VERSION,
    wcwidth(codepoint: number): 0 | 1 | 2 {
      const baseWidth = baseProvider.wcwidth(codepoint)
      return resolveEastAsianAmbiguousCellWidth(codepoint, baseWidth, eastAsianAmbiguousWidthMode)
    },
    charProperties(codepoint: number, preceding: number): number {
      const precedingWidth = extractWidth(preceding)
      const precedingKind = extractCharKind(preceding)

      if (codepoint === ZERO_WIDTH_JOINER && precedingWidth > 0) {
        return createProperties(ZERO_WIDTH_JOINER, precedingWidth, true)
      }

      if (precedingKind === ZERO_WIDTH_JOINER && precedingWidth > 0) {
        const width = baseProvider.wcwidth(codepoint)
        const resolved = resolveEastAsianAmbiguousCellWidth(
          codepoint,
          width,
          eastAsianAmbiguousWidthMode
        )
        if (resolved > 0) {
          // Why: CLIs render ZWJ emoji as one visible glyph and budget them as one
          // wide cell pair; xterm Unicode11 otherwise advances for both emoji parts.
          return createProperties(codepoint, precedingWidth, true)
        }
      }

      const base = baseProvider.charProperties(codepoint, preceding)
      const desiredWidth = resolveEastAsianAmbiguousCellWidth(
        codepoint,
        baseProvider.wcwidth(codepoint),
        eastAsianAmbiguousWidthMode
      )
      // Why: charProperties packs width into the property word; keep it aligned
      // with wcwidth when wide-mode expands East Asian Ambiguous cells.
      if (desiredWidth !== extractWidth(base)) {
        return createProperties(extractCharKind(base), desiredWidth, (base & 1) === 1)
      }
      return base
    }
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
    unicode.register(createOrcaUnicodeProvider(baseProvider))
  }
  unicode.activeVersion = ORCA_UNICODE_VERSION
}
