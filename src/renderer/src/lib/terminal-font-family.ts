// Cross-platform monospace chain: browsers skip fonts absent on the current OS, so listing all is safe.
// Nerd Fonts come last to cover PUA glyphs (U+E000–U+F8FF) from OMP/Powerline that standard monospace fonts lack.
const FALLBACK_FONTS = [
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
  'Hack Nerd Font', // common Nerd Font among Linux developers
  // None of the Latin fonts above carry Hangul/Kana/Han. Without a CJK entry the
  // browser substitutes a proportional system face whose advance is not two cells
  // wide, so CJK text renders with gaps and drifts out of the grid.
  //
  // Coding faces first: their Hangul is exactly two Latin advances wide. Then
  // platform defaults, native before foreign — none has exact dual-width metrics,
  // so a font that merely happens to be installed (e.g. Malgun via Office on a
  // Mac) must not outrank the one the OS ships, or two machines of the same
  // platform render Hangul differently.
  //
  // Platform defaults are listed under their English and localized family names:
  // a CJK-locale OS registers them under the localized name only, and an entry
  // the platform does not know costs nothing in a CSS font stack.
  'D2Coding', // Korean coding font; Hangul is exactly 2x the Latin advance
  'NanumGothicCoding', // Korean coding font, common on Linux
  '나눔고딕코딩',
  'Sarasa Mono K', // CJK monospace built for exact dual-width metrics
  'Noto Sans Mono CJK KR', // Linux (common)
  'Apple SD Gothic Neo', // macOS Korean default — always present on macOS
  'Apple SD 산돌고딕 Neo',
  'Malgun Gothic', // Windows Korean default
  '맑은 고딕',
  'MS Gothic', // Windows; dual-width, but Japanese-first
  'ＭＳ ゴシック',
  'Hiragino Sans', // macOS Japanese default
  'ヒラギノ角ゴシック',
  'monospace' // ultimate generic fallback
] as const

export function buildFontFamily(fontFamily: string): string {
  const trimmed = fontFamily.trim()
  const parts = trimmed ? [`"${trimmed}"`] : []
  const lowerParts = parts.map((p) => p.toLowerCase())
  // Append each fallback unless already present (case-insensitive) to avoid duplicates.
  for (const fallback of FALLBACK_FONTS) {
    const lower = fallback.toLowerCase()
    if (!lowerParts.some((p) => p.includes(lower))) {
      // Generic keywords like "monospace" are unquoted; named fonts are quoted.
      parts.push(fallback === 'monospace' ? fallback : `"${fallback}"`)
    }
  }
  return parts.join(', ')
}

/** The chain with no user font in front — the default for panes that carry no font setting. */
export const DEFAULT_TERMINAL_FONT_FAMILY = buildFontFamily('')
