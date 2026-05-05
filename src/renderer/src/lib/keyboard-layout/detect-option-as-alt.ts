/**
 * Layout-aware default for the macOS Option-as-Alt setting.
 *
 * Why this exists: when the Option key acts as Meta/Alt, xterm.js skips
 * macOS's dead-key composition, which stops non-US layouts from producing
 * essential punctuation (Turkish Option+Q → `@`, German Option+L → `@`,
 * French Option+E → `€`, etc.). When Option composes, US users lose
 * readline word-nav (Option+B = backward-word becomes `∫`).
 *
 * The only defensible default is the one that varies per layout. This
 * module fingerprints the active layout from Chromium's
 * navigator.keyboard.getLayoutMap() (ships in Chrome 69+, so every Electron
 * we could run). We match Ghostty's taxonomy: US / US-International map to
 * `true`; everything else — including Dvorak, Colemak, UK, every
 * international layout — maps to `false`.
 *
 * Reference implementation in Ghostty:
 *   ~/projects/ghostty/src/input/keyboard.zig:25-57 (Layout enum + detectOptionAsAlt)
 *   ~/projects/ghostty/macos/Sources/Helpers/KeyboardLayout.swift (Carbon probe)
 */

/** Minimal shape of the `KeyboardLayoutMap` we consume, so callers can stub
 *  without importing DOM types into non-browser test environments. */
export type LayoutMapLike = {
  get: (code: string) => string | undefined
  size: number
}

export type DetectedLayoutCategory =
  /** US Standard or US-International. Default → `'true'` (Option = Alt). */
  | 'us'
  /** Any other recognized layout (UK, German, Turkish, French, Dvorak, etc.).
   *  Default → `'false'` (Option composes layout characters). */
  | 'non-us'
  /** API unavailable, empty map, or fingerprint incomplete. Default →
   *  `'false'` — the conservative safe choice, matching Ghostty's
   *  `.unknown => .false`. */
  | 'unknown'

/**
 * Nine physical keys whose unshifted codepoint is ASCII on US / US-International
 * but differs on every other recognized layout. A layout is classified as `us`
 * only if *every* key in this map reports its US value; any mismatch → `non-us`;
 * any missing entry → `unknown`.
 *
 * Cross-layout truth table (verified against Apple keylayout sources):
 *
 *  | Key        | US | UK | DE-QWERTZ | FR-AZERTY | ES | Turkish-Q | Turkish-F | Swedish | Dvorak | Colemak |
 *  |------------|----|----|-----------|-----------|----|-----------|-----------|---------|--------|---------|
 *  | KeyQ       | q  | q  | q         | a         | q  | q         | f         | q       | '      | q       |
 *  | KeyW       | w  | w  | w         | z         | w  | w         | g         | w       | ,      | w       |
 *  | KeyA       | a  | a  | a         | q         | a  | a         | u         | a       | a      | a       |
 *  | KeyZ       | z  | z  | y         | w         | z  | z         | j         | z       | ;      | z       |
 *  | Semicolon  | ;  | ;  | ö         | m         | ñ  | ş         | s         | ö       | s      | o       |
 *  | Quote      | '  | '  | ä         | ù         | ´  | i         | y         | ä       | -      | '       |
 *  | Backquote  | `  | `  | ^         | @         | º  | "         | +         | §       | `      | `       |
 *  | BracketLeft| [  | [  | ü         | )         | `  | ğ         | ğ         | å       | /      | [       |
 *  | BracketRight| ]  | ]  | +         | =         | +  | ü         | ü         | ¨       | =      | ]       |
 *
 * Colemak passes KeyQ/W/A/Z/Quote/Backquote/BracketLeft/BracketRight but fails
 * Semicolon (`o` vs `;`). Dvorak fails KeyQ immediately. Both get classified
 * as `non-us` and default to `'false'`; users who want `'true'` flip the
 * explicit override. Matches Ghostty (Ghostty only whitelists
 * com.apple.keylayout.US and com.apple.keylayout.USInternational).
 */
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
      // Incomplete map. Bail rather than guess — `unknown` → `'false'` is
      // safe (composition works; B/F/D word-nav still handled by the
      // existing terminal-shortcut-policy compensation).
      return 'unknown'
    }
    if (actual !== expected) {
      return 'non-us'
    }
  }
  return 'us'
}

/** The xterm-side default for a given detection outcome. `'false'` is the
 *  conservative fallback for `unknown` to protect non-US users (the bug in
 *  issue #903 was exactly the opposite default — assuming `'true'` for
 *  everyone). */
export function detectedCategoryToDefault(category: DetectedLayoutCategory): 'true' | 'false' {
  return category === 'us' ? 'true' : 'false'
}

export type EffectiveMacOptionAsAlt = 'true' | 'false' | 'left' | 'right'

/** Resolve the setting value (which can be `'auto'` plus four explicit modes)
 *  into the terminal-facing value (four explicit modes only). */
export function effectiveMacOptionAsAlt(
  setting: 'auto' | 'true' | 'false' | 'left' | 'right',
  detected: DetectedLayoutCategory
): EffectiveMacOptionAsAlt {
  if (setting === 'auto') {
    return detectedCategoryToDefault(detected)
  }
  return setting
}
