import { splitFontFamilyList } from '../../styles/font-family-list'

// Auto-enable known ligature fonts; substring matching recognizes variants such as JetBrainsMono NF.
const LIGATURE_FONT_TOKENS = [
  'fira code',
  'fira mono',
  'jetbrains mono',
  'jetbrainsmono',
  'cascadia code',
  'cascadia mono',
  'iosevka',
  'victor mono',
  'hasklig',
  'monoid',
  'operator mono',
  'dank mono',
  'mononoki',
  'pragmatapro',
  'recursive',
  'monolisa',
  'commit mono',
  'geist mono',
  'maple mono',
  'departure mono'
] as const

/** Inspect only the user’s first family, never fallbacks that could override that choice. */
export function fontFamilyHasKnownLigatures(fontFamily: string | null | undefined): boolean {
  if (!fontFamily) {
    return false
  }
  // A setting or CSS stack can list several families; only the first decides.
  const primary = splitFontFamilyList(fontFamily)[0]?.toLowerCase() ?? ''
  if (!primary) {
    return false
  }
  return LIGATURE_FONT_TOKENS.some((token) => primary.includes(token))
}

/** Explicit on/off survives font changes; auto follows font detection. */
export function resolveTerminalLigaturesEnabled(
  mode: 'auto' | 'on' | 'off' | null | undefined,
  fontFamily: string | null | undefined
): boolean {
  if (mode === 'on') {
    return true
  }
  if (mode === 'off') {
    return false
  }
  return fontFamilyHasKnownLigatures(fontFamily)
}
