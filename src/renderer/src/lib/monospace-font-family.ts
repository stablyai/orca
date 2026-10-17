import { getRendererAppPlatform } from './renderer-app-platform'

// Cross-platform monospace chain: browsers skip fonts absent on the current OS, so listing all is safe.
const LATIN_MONOSPACE_FONTS = [
  'SF Mono', // macOS 10.12+
  'Menlo', // macOS (older)
  'Monaco', // macOS (legacy)
  'Cascadia Mono', // Windows 11+
  'Consolas', // Windows Vista+
  'DejaVu Sans Mono', // Linux (common)
  'Liberation Mono' // Linux (common)
] as const

// Nerd Fonts come after the Latin fonts to cover PUA glyphs (U+E000–U+F8FF) from OMP/Powerline that standard monospace fonts lack.
const SYMBOL_FONTS = [
  'Orca Nerd Font Symbols', // bundled PUA fallback for OMP/Powerline glyphs
  'Symbols Nerd Font Mono', // purpose-built Nerd Fonts symbols-only fallback
  'MesloLGS Nerd Font', // p10k's recommended font; very common on zsh setups
  'JetBrainsMono Nerd Font', // widely installed; Ghostty ships a JBM-derived font
  'Hack Nerd Font' // common Nerd Font among Linux developers
] as const

export type CjkScript = 'ko' | 'ja' | 'zh-Hans' | 'zh-Hant'

type CjkFontPlatform = 'darwin' | 'win32' | 'linux'

// Why per OS: only the platform's own CJK faces share its UI metrics; a cross-installed
// face (e.g. Office fonts on macOS) should not win over the native one.
const CJK_FONTS: Record<CjkFontPlatform, Record<CjkScript, readonly string[]>> = {
  darwin: {
    ko: ['Apple SD Gothic Neo'],
    ja: ['Hiragino Sans', 'Hiragino Kaku Gothic ProN'],
    'zh-Hans': ['PingFang SC'],
    'zh-Hant': ['PingFang TC', 'PingFang HK']
  },
  win32: {
    ko: ['Malgun Gothic'],
    ja: ['Yu Gothic', 'Meiryo'],
    'zh-Hans': ['Microsoft YaHei'],
    'zh-Hant': ['Microsoft JhengHei']
  },
  linux: {
    ko: [
      'Noto Sans Mono CJK KR',
      'Noto Sans CJK KR',
      'D2Coding',
      'NanumGothicCoding',
      'Sarasa Mono K'
    ],
    ja: ['Noto Sans Mono CJK JP', 'Noto Sans CJK JP', 'Sarasa Mono J'],
    'zh-Hans': [
      'Noto Sans Mono CJK SC',
      'Noto Sans CJK SC',
      'Sarasa Mono SC',
      'WenQuanYi Zen Hei Mono'
    ],
    'zh-Hant': ['Noto Sans Mono CJK TC', 'Noto Sans CJK TC', 'Sarasa Mono TC']
  }
}

// Why SC first without a CJK locale: its faces carry the largest Han repertoire; Hangul
// still resolves to the KR face because the SC/JP/TC faces on macOS/Windows lack it.
const DEFAULT_CJK_ORDER: readonly CjkScript[] = ['zh-Hans', 'ja', 'zh-Hant', 'ko']

/** First CJK language in the user's preference list decides which Han glyph shapes win. */
export function resolvePreferredCjkScript(locales: readonly string[]): CjkScript | null {
  for (const locale of locales) {
    const tag = locale.toLowerCase()
    if (tag === 'ko' || tag.startsWith('ko-')) {
      return 'ko'
    }
    if (tag === 'ja' || tag.startsWith('ja-')) {
      return 'ja'
    }
    if (tag === 'zh' || tag.startsWith('zh-')) {
      return /^zh-(hant|tw|hk|mo)\b/.test(tag) ? 'zh-Hant' : 'zh-Hans'
    }
  }
  return null
}

export function buildCjkFallbackFonts(
  platform: NodeJS.Platform,
  locales: readonly string[]
): string[] {
  const fontsByScript =
    CJK_FONTS[platform === 'darwin' || platform === 'win32' ? platform : 'linux']
  const preferred = resolvePreferredCjkScript(locales)
  const order = preferred
    ? [preferred, ...DEFAULT_CJK_ORDER.filter((script) => script !== preferred)]
    : DEFAULT_CJK_ORDER
  return order.flatMap((script) => fontsByScript[script])
}

function readNavigatorLocales(): readonly string[] {
  if (typeof navigator === 'undefined') {
    return []
  }
  return navigator.languages?.length ? navigator.languages : [navigator.language ?? '']
}

export type FontFamilyChainOptions = {
  platform?: NodeJS.Platform
  locales?: readonly string[]
}

export function buildFontFamily(fontFamily: string, options: FontFamilyChainOptions = {}): string {
  const trimmed = fontFamily.trim()
  const parts = trimmed ? [`"${trimmed}"`] : []
  const lowerParts = parts.map((p) => p.toLowerCase())
  // Why after the symbol fonts: every glyph the chain resolved before keeps its font; CJK
  // faces only claim what used to fall through to the OS's arbitrary per-glyph fallback.
  const fallbacks = [
    ...LATIN_MONOSPACE_FONTS,
    ...SYMBOL_FONTS,
    ...buildCjkFallbackFonts(
      options.platform ?? getRendererAppPlatform(),
      options.locales ?? readNavigatorLocales()
    ),
    'monospace' // ultimate generic fallback
  ]
  // Append each fallback unless already present (case-insensitive) to avoid duplicates.
  for (const fallback of fallbacks) {
    const lower = fallback.toLowerCase()
    if (!lowerParts.some((p) => p.includes(lower))) {
      // Generic keywords like "monospace" are unquoted; named fonts are quoted.
      parts.push(fallback === 'monospace' ? fallback : `"${fallback}"`)
    }
  }
  return parts.join(', ')
}
