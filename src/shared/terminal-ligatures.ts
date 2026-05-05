// Font families that ship with programming-ligatures out of the box. Used by
// the `'auto'` mode of `terminalLigatures` so users who pick a ligature font
// get the feature for free without touching settings. Matching is
// case-insensitive and substring-based so variants like "JetBrainsMono NF"
// still resolve.
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

/** Whether a user-facing font-family string looks like one of the well-known
 *  ligature-capable programming fonts. Matches the first declared family in
 *  the string (the user's choice) rather than any fallback. */
export function fontFamilyHasKnownLigatures(fontFamily: string | null | undefined): boolean {
  if (!fontFamily) {
    return false
  }
  // `terminalFontFamily` is a single family name in settings, but
  // defensively split on commas so the helper also works when fed a full
  // `font-family` stack (e.g. via `buildFontFamily`).
  const primary = fontFamily.split(',')[0]?.replace(/"/g, '').trim().toLowerCase() ?? ''
  if (!primary) {
    return false
  }
  return LIGATURE_FONT_TOKENS.some((token) => primary.includes(token))
}

/** Resolve the effective ligature-enabled state from the user setting and
 *  the current font. `'auto'` defers to font detection; explicit `'on'` /
 *  `'off'` always wins so a user who disables ligatures keeps them disabled
 *  even after switching to Fira Code. */
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
