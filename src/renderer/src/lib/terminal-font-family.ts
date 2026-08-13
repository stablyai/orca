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

// None of the Latin fonts above carry Hangul/Kana/Han. Without a CJK entry the
// browser substitutes a proportional system face whose advance is not two cells
// wide, so CJK text renders with gaps and drifts out of the grid.
//
// Coding faces first: their Hangul is exactly two Latin advances wide.
const CJK_CODING_FONTS = [
  'D2Coding', // Korean coding font; Hangul is exactly 2x the Latin advance
  'NanumGothicCoding', // Korean coding font, common on Linux
  '나눔고딕코딩',
  'Sarasa Mono K', // CJK monospace built for exact dual-width metrics
  'Noto Sans Mono CJK KR' // Linux (common)
] as const

export type TerminalFontPlatform = 'darwin' | 'win32' | 'linux'

// Platform system defaults after the coding faces — none has exact dual-width
// metrics, so a font that merely happens to be installed (e.g. Malgun via
// Office on a Mac) must not outrank the one the OS ships, or two machines of
// the same platform render Hangul differently. The current platform's native
// group therefore goes first at runtime; the other platforms' groups stay in
// the chain because the browser skips fonts absent on this OS.
//
// Platform defaults are listed under their English and localized family names:
// a CJK-locale OS registers them under the localized name only, and an entry
// the platform does not know costs nothing in a CSS font stack.
const CJK_PLATFORM_FONT_GROUPS: Record<TerminalFontPlatform, readonly string[]> = {
  darwin: [
    'Apple SD Gothic Neo', // macOS Korean default — always present on macOS
    'Apple SD 산돌고딕 Neo',
    'Hiragino Sans', // macOS Japanese default
    'ヒラギノ角ゴシック'
  ],
  win32: [
    'Malgun Gothic', // Windows Korean default
    '맑은 고딕',
    'MS Gothic', // Windows; dual-width, but Japanese-first
    'ＭＳ ゴシック'
  ],
  // Linux ships no single system CJK default; Noto Sans Mono CJK KR above covers it.
  linux: []
}

function orderedCjkPlatformFonts(platform: TerminalFontPlatform): string[] {
  const foreign = (['darwin', 'win32', 'linux'] as const).filter((p) => p !== platform)
  return [platform, ...foreign].flatMap((p) => [...CJK_PLATFORM_FONT_GROUPS[p]])
}

export function detectTerminalFontPlatform(): TerminalFontPlatform {
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (userAgent.includes('Windows')) {
    return 'win32'
  }
  if (userAgent.includes('Mac')) {
    return 'darwin'
  }
  if (typeof process !== 'undefined') {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      return process.platform
    }
  }
  return 'linux'
}

export function buildFontFamily(
  fontFamily: string,
  platform: TerminalFontPlatform = detectTerminalFontPlatform()
): string {
  const trimmed = fontFamily.trim()
  // JSON escaping of `"` and `\` coincides with CSS string escaping, so a
  // family name cannot terminate the quoted string early (same approach as
  // app-font-family.ts). Fallbacks below are static literals and stay as-is.
  const parts = trimmed ? [JSON.stringify(trimmed)] : []
  // Track complete normalized family names: "My SF Mono Custom" is a distinct
  // CSS family from "SF Mono", so substring matching must not suppress a fallback.
  const knownFamilies = new Set(trimmed ? [trimmed.toLowerCase()] : [])
  const fallbacks = [
    ...LATIN_FALLBACK_FONTS,
    ...CJK_CODING_FONTS,
    ...orderedCjkPlatformFonts(platform),
    'monospace' // ultimate generic fallback
  ]
  // Append each fallback unless already present (case-insensitive) to avoid duplicates.
  for (const fallback of fallbacks) {
    const lower = fallback.toLowerCase()
    if (!knownFamilies.has(lower)) {
      // Generic keywords like "monospace" are unquoted; named fonts are quoted.
      parts.push(fallback === 'monospace' ? fallback : `"${fallback}"`)
      knownFamilies.add(lower)
    }
  }
  return parts.join(', ')
}

/** The chain with no user font in front — the default for panes that carry no font setting. */
export const DEFAULT_TERMINAL_FONT_FAMILY = buildFontFamily('')
