// Cross-platform monospace chain: browsers skip fonts absent on the current OS, so listing all is safe.
// Nerd Fonts come last to cover PUA glyphs (U+E000–U+F8FF) from OMP/Powerline that standard monospace fonts lack.
const FALLBACK_FONTS = [
  'SF Mono',
  'Menlo',
  'Monaco',
  'Cascadia Mono',
  'Consolas',
  'DejaVu Sans Mono',
  'Liberation Mono',
  'Orca Nerd Font Symbols',
  'Symbols Nerd Font Mono',
  'MesloLGS Nerd Font',
  'JetBrainsMono Nerd Font',
  'Hack Nerd Font',
  'monospace'
] as const

// Why: wide ambiguous mode allocates two cells; CJK UI fonts supply full-em
// glyphs so ①/★ are legible instead of Consolas' tiny ink (#9958).
const CJK_AMBIGUOUS_FALLBACK_FONTS = [
  'Malgun Gothic',
  'Microsoft YaHei',
  'Yu Gothic',
  'Meiryo',
  'Apple SD Gothic Neo',
  'PingFang SC',
  'Hiragino Sans',
  'Noto Sans CJK KR',
  'Noto Sans CJK SC',
  'Noto Sans CJK JP'
] as const

export type BuildFontFamilyOptions = {
  /** When true, insert CJK UI fonts ahead of Consolas for full-size ambiguous glyphs. */
  eastAsianAmbiguousWide?: boolean
}

export function buildFontFamily(fontFamily: string, options?: BuildFontFamilyOptions): string {
  const trimmed = fontFamily.trim()
  const parts = trimmed ? [`"${trimmed}"`] : []
  const lowerParts = parts.map((p) => p.toLowerCase())
  const fallbacks: string[] = [...FALLBACK_FONTS]
  // Why: place CJK before Consolas so Cascadia/SF Mono still win for Latin, but
  // missing ambiguous glyphs skip Consolas' narrow ink (#9958).
  if (options?.eastAsianAmbiguousWide) {
    const consolasIndex = fallbacks.indexOf('Consolas')
    const insertAt = consolasIndex >= 0 ? consolasIndex : fallbacks.length
    fallbacks.splice(insertAt, 0, ...CJK_AMBIGUOUS_FALLBACK_FONTS)
  }
  for (const fallback of fallbacks) {
    const lower = fallback.toLowerCase()
    if (!lowerParts.some((p) => p.includes(lower))) {
      // Generic keywords like "monospace" are unquoted; named fonts are quoted.
      parts.push(fallback === 'monospace' ? fallback : `"${fallback}"`)
      lowerParts.push(lower)
    }
  }
  return parts.join(', ')
}
