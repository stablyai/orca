// Cross-platform monospace chain: browsers skip fonts absent on the current OS, so listing all is safe.
// Nerd Fonts come last to cover PUA glyphs (U+E000–U+F8FF) from OMP/Powerline that standard monospace fonts lack.
const LATIN_FALLBACK_FONTS = [
  'SF Mono', // macOS 10.12+
  'Menlo', // macOS (older)
  'Monaco', // macOS (legacy)
  'Cascadia Mono', // Windows 11+
  'Consolas', // Windows Vista+
  'DejaVu Sans Mono', // Linux (common)
  'Liberation Mono', // Linux (common)
  'Orca Nerd Font Symbols', // bundled PUA fallback for OMP/Powerline glyphs
  'Symbols Nerd Font Mono', // purpose-built Nerd Fonts symbols-only fallback
  'MesloLGS Nerd Font', // p10k's recommended font; very common on zsh setups
  'JetBrainsMono Nerd Font', // widely installed; Ghostty ships a JBM-derived font
  'Hack Nerd Font' // common Nerd Font among Linux developers
] as const

// None of the fonts above carry Hangul/Kana/Han. Without an entry here the browser
// substitutes a proportional system face whose advance is not two cells wide, so
// CJK text renders with gaps and drifts out of the grid.
const CJK_FALLBACK_FONTS = [
  // Coding faces first: their Hangul is exactly two Latin advances wide.
  'D2Coding',
  'NanumGothicCoding',
  '나눔고딕코딩',
  'Sarasa Mono K',
  'Noto Sans Mono CJK KR',
  // Then platform defaults, native before foreign — none has exact dual-width
  // metrics, so a font that merely happens to be installed must not outrank the
  // one the OS ships, or two Macs render Hangul differently.
  //
  // Each is listed under its English and its localized family name: a CJK-locale
  // OS registers these under the localized name only, and an entry the platform
  // does not know simply costs nothing.
  'Apple SD Gothic Neo', // macOS Korean
  'Apple SD 산돌고딕 Neo',
  'Malgun Gothic', // Windows Korean
  '맑은 고딕',
  'MS Gothic', // Windows; dual-width, but Japanese-first
  'ＭＳ ゴシック',
  'Hiragino Sans', // macOS Japanese
  'ヒラギノ角ゴシック'
] as const

const GENERIC_FALLBACK = 'monospace'

function quote(fontFamily: string): string {
  return `"${fontFamily}"`
}

/**
 * The chain xterm renders with: the user's font, the cross-platform Latin
 * fallbacks, then CJK. A chosen CJK font sits behind the Nerd Fonts rather than
 * at the front, so it answers for Hangul without claiming the PUA glyphs
 * Powerline prompts draw from.
 */
export function buildFontFamily(fontFamily: string, cjkFontFamily: string = ''): string {
  const primary = fontFamily.trim()
  const cjk = cjkFontFamily.trim()
  const chosen = [primary, cjk].filter(Boolean).map((font) => font.toLowerCase())
  // Skip a fallback the user already named, so it is not listed twice. Compare
  // complete family names: "My SF Mono Custom" is a distinct CSS family from
  // "SF Mono", so a substring match must not suppress the real fallback.
  const isChosen = (font: string): boolean => chosen.includes(font.toLowerCase())

  const parts = primary ? [quote(primary)] : []
  parts.push(...LATIN_FALLBACK_FONTS.filter((font) => !isChosen(font)).map(quote))
  if (cjk) {
    parts.push(quote(cjk))
  }
  parts.push(...CJK_FALLBACK_FONTS.filter((font) => !isChosen(font)).map(quote))
  // Generic keywords are unquoted.
  parts.push(GENERIC_FALLBACK)
  return parts.join(', ')
}

/** The chain with no user font in front — the default for panes that carry no font setting. */
export const DEFAULT_TERMINAL_FONT_FAMILY = buildFontFamily('')
