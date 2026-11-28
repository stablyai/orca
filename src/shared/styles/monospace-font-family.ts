import { getCurrentLocalPlatform } from '../execution-host/execution-host'
import { isPluginFontFamilyName } from '../plugins/contributions/plugin-font-contribution'
import { buildFontFamilyList, prepareFontFallbacks, splitFontFamilyList } from './font-family-list'

export const BUNDLED_SYMBOLS_FONT_FAMILY = 'Orca Nerd Font Symbols'

// Cross-platform monospace chain: browsers skip fonts absent on the current OS, so listing all is safe.
const LATIN_MONOSPACE_FONTS = [
  'SF Mono',
  'Menlo',
  'Monaco',
  'Cascadia Mono',
  'Consolas',
  'DejaVu Sans Mono',
  'Liberation Mono'
] as const

// Nerd Fonts come after the Latin fonts to cover PUA glyphs (U+E000–U+F8FF) from OMP/Powerline that standard monospace fonts lack.
const SYMBOL_FONTS = [
  BUNDLED_SYMBOLS_FONT_FAMILY,
  'Symbols Nerd Font Mono',
  'MesloLGS Nerd Font',
  'JetBrainsMono Nerd Font',
  'Hack Nerd Font'
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
  platform: NodeJS.Platform | null,
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
  platform?: NodeJS.Platform | null
  locales?: readonly string[]
}

type PreparedFallbacks = ReturnType<typeof prepareFontFallbacks>

let cachedFallbacks: { key: string; fallbacks: PreparedFallbacks } | null = null

// Why after the symbol fonts: every glyph the chain resolved before keeps its font; CJK
// faces only claim what used to fall through to the OS's arbitrary per-glyph fallback.
function resolveFallbacks(options: FontFamilyChainOptions): PreparedFallbacks {
  const cjk = buildCjkFallbackFonts(
    options.platform ?? getCurrentLocalPlatform(),
    options.locales ?? readNavigatorLocales()
  )
  const key = cjk.join('\n')
  if (cachedFallbacks?.key !== key) {
    cachedFallbacks = {
      key,
      fallbacks: prepareFontFallbacks([
        ...LATIN_MONOSPACE_FONTS,
        ...SYMBOL_FONTS,
        ...cjk,
        'monospace'
      ])
    }
  }
  return cachedFallbacks.fallbacks
}

export function buildFontFamily(fontFamily: string, options: FontFamilyChainOptions = {}): string {
  const fallbacks = resolveFallbacks(options)
  const families = splitFontFamilyList(fontFamily)
  if (families.length > 1) {
    return buildFontFamilyList(families, fallbacks)
  }
  // Why: a single family is quoted as typed, keyword or not, and drops each fallback its name contains.
  const family = families[0] ?? ''
  const parts = family ? [`"${family}"`] : []
  const lowerFamily = family.toLowerCase()
  // Why: a plugin family such as "Menlo (acme.fonts)" is never a fallback, so it must keep all of them.
  const isPluginFamily = isPluginFontFamilyName(family)
  for (const fallback of fallbacks) {
    if (isPluginFamily || !lowerFamily.includes(fallback.lower)) {
      parts.push(fallback.quoted)
    }
  }
  return parts.join(', ')
}
