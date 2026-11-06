/** Default Option-as-Meta only for standard ABC/US: other layouts need Option composition. Browser base fingerprints cannot distinguish US-shaped international/IME layouts; native input-source identity narrows them, with conservative macOS fallback. */

/** Minimal layout-map shape keeps stubs independent of browser DOM types. */
export type LayoutMapLike = {
  get: (code: string) => string | undefined
  size: number
}

export type DetectedLayoutCategory =
  /** US-shaped base layer; a native input-source override may still require composition. */
  | 'us'
  /** Any other recognized layout (UK, German, Turkish, French, Dvorak, etc.).
   *  Default → `'false'` (Option composes layout characters). */
  | 'non-us'
  /** API unavailable, empty map, or fingerprint incomplete. Default →
   *  `'false'` so Option remains available for composition. */
  | 'unknown'

/** Require every physical key’s US value; mismatches reject Dvorak/Colemak/international layouts and missing keys stay unknown. Native identity separately distinguishes US-shaped composition layouts. */
const US_FINGERPRINT: Record<string, string> = {
  KeyQ: 'q',
  KeyW: 'w',
  KeyA: 'a',
  KeyZ: 'z',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']'
}

export function detectOptionAsAltFromLayoutMap(
  layoutMap: LayoutMapLike | null | undefined
): DetectedLayoutCategory {
  if (!layoutMap || layoutMap.size === 0) {
    return 'unknown'
  }
  for (const [code, expected] of Object.entries(US_FINGERPRINT)) {
    const actual = layoutMap.get(code)
    if (actual === undefined) {
      // Incomplete maps stay conservative so composition works; shortcut policy still compensates B/F/D navigation.
      return 'unknown'
    }
    if (actual !== expected) {
      return 'non-us'
    }
  }
  return 'us'
}

/** Unknown defaults to composition to protect non-US layouts (#903). */
export function detectedCategoryToDefault(category: DetectedLayoutCategory): 'true' | 'false' {
  return category === 'us' ? 'true' : 'false'
}

export type EffectiveMacOptionAsAlt = 'true' | 'false' | 'left' | 'right'

export function effectiveMacOptionAsAlt(
  setting: 'auto' | 'true' | 'false' | 'left' | 'right',
  detected: DetectedLayoutCategory
): EffectiveMacOptionAsAlt {
  if (setting === 'auto') {
    return detectedCategoryToDefault(detected)
  }
  return setting
}
