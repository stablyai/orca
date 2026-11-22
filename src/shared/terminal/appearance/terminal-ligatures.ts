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
  // Settings hold one family, but callers may pass a full CSS stack.
  const primary = fontFamily.split(',')[0]?.replace(/"/g, '').trim().toLowerCase() ?? ''
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
