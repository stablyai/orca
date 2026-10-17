import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildCjkFallbackFonts,
  buildFontFamily,
  resolvePreferredCjkScript
} from './monospace-font-family'

vi.mock('./renderer-app-platform', () => ({
  getRendererAppPlatform: (): NodeJS.Platform => 'darwin'
}))

const LATIN_AND_SYMBOLS =
  '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Orca Nerd Font Symbols", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font"'
const MAC_EN_CJK =
  '"PingFang SC", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "PingFang TC", "PingFang HK", "Apple SD Gothic Neo"'
const FULL_FALLBACK = `${LATIN_AND_SYMBOLS}, ${MAC_EN_CJK}, monospace`
const MAC_EN = { platform: 'darwin', locales: ['en-US'] } as const

describe('buildFontFamily', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('puts custom font first with full cross-platform fallback chain', () => {
    expect(buildFontFamily('JetBrains Mono', MAC_EN)).toBe(`"JetBrains Mono", ${FULL_FALLBACK}`)
  })

  it('does not duplicate SF Mono when it is the input', () => {
    expect(buildFontFamily('SF Mono', MAC_EN)).toBe(FULL_FALLBACK)
  })

  it('returns full fallback chain for empty string', () => {
    expect(buildFontFamily('', MAC_EN)).toBe(FULL_FALLBACK)
  })

  it('treats whitespace-only string same as empty', () => {
    expect(buildFontFamily('   ', MAC_EN)).toBe(FULL_FALLBACK)
  })

  it('does not duplicate when font name contains "sf mono" (case-insensitive)', () => {
    expect(buildFontFamily('My SF Mono Custom', MAC_EN)).toBe(
      `"My SF Mono Custom", ${FULL_FALLBACK.replace('"SF Mono", ', '')}`
    )
  })

  it('does not duplicate Consolas when it is the input', () => {
    expect(buildFontFamily('Consolas', MAC_EN)).toBe(
      `"Consolas", ${FULL_FALLBACK.replace('"Consolas", ', '')}`
    )
  })

  it('does not duplicate MesloLGS Nerd Font when it is the input', () => {
    expect(buildFontFamily('MesloLGS Nerd Font', MAC_EN)).toBe(
      `"MesloLGS Nerd Font", ${FULL_FALLBACK.replace('"MesloLGS Nerd Font", ', '')}`
    )
  })

  it('does not duplicate the bundled Nerd Font symbol fallback', () => {
    expect(buildFontFamily('Orca Nerd Font Symbols', MAC_EN)).toBe(
      `"Orca Nerd Font Symbols", ${FULL_FALLBACK.replace('"Orca Nerd Font Symbols", ', '')}`
    )
  })

  it('does not duplicate a CJK face the user picked as the primary font', () => {
    const chain = buildFontFamily('Apple SD Gothic Neo', { platform: 'darwin', locales: ['ko'] })
    expect(chain.startsWith('"Apple SD Gothic Neo", "SF Mono"')).toBe(true)
    expect(chain.match(/Apple SD Gothic Neo/g)).toHaveLength(1)
  })

  it('keeps every Latin and symbol font ahead of the CJK faces', () => {
    const chain = buildFontFamily('', { platform: 'win32', locales: ['ko-KR'] })
    expect(chain).toBe(
      `${LATIN_AND_SYMBOLS}, "Malgun Gothic", "Microsoft YaHei", "Yu Gothic", "Meiryo", "Microsoft JhengHei", monospace`
    )
  })

  it('never lists another platform’s CJK faces', () => {
    const mac = buildFontFamily('', { platform: 'darwin', locales: ['ko'] })
    expect(mac).not.toContain('Malgun Gothic')
    expect(mac).not.toContain('Noto Sans')
    const windows = buildFontFamily('', { platform: 'win32', locales: ['ja'] })
    expect(windows).not.toContain('Hiragino')
    expect(windows).not.toContain('Noto Sans')
    const linux = buildFontFamily('', { platform: 'linux', locales: ['zh-CN'] })
    expect(linux).not.toContain('PingFang')
    expect(linux).not.toContain('Microsoft YaHei')
  })

  it('reads the platform and navigator.languages when no options are given', () => {
    vi.stubGlobal('navigator', { languages: ['en-US', 'ja-JP'], language: 'en-US' })
    expect(buildFontFamily('')).toBe(
      `${LATIN_AND_SYMBOLS}, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "PingFang SC", "PingFang TC", "PingFang HK", "Apple SD Gothic Neo", monospace`
    )
  })

  it('falls back to navigator.language when navigator.languages is empty', () => {
    vi.stubGlobal('navigator', { languages: [], language: 'zh-TW' })
    expect(buildFontFamily('')).toContain(`${LATIN_AND_SYMBOLS}, "PingFang TC", "PingFang HK",`)
  })
})

describe('resolvePreferredCjkScript', () => {
  it.each([
    [['ko-KR', 'en-US'], 'ko'],
    [['ko'], 'ko'],
    [['en-US', 'ja-JP'], 'ja'],
    [['JA'], 'ja'],
    [['zh-CN'], 'zh-Hans'],
    [['zh'], 'zh-Hans'],
    [['zh-Hans-SG'], 'zh-Hans'],
    [['zh-TW'], 'zh-Hant'],
    [['zh-HK'], 'zh-Hant'],
    [['zh-Hant-MO'], 'zh-Hant'],
    [['fr-FR', 'zh-TW', 'ko-KR'], 'zh-Hant']
  ] as const)('maps %j to %s', (locales, script) => {
    expect(resolvePreferredCjkScript(locales)).toBe(script)
  })

  it.each([
    [[]],
    [['en-US', 'fr']],
    // Konkani, Javanese, Zhuang: prefixes that only look like ko/ja/zh.
    [['kok', 'jv', 'jav', 'zha']],
    [['']]
  ] as const)('returns null for %j', (locales) => {
    expect(resolvePreferredCjkScript(locales)).toBeNull()
  })
})

describe('buildCjkFallbackFonts', () => {
  it('orders Korean faces first for a Korean locale', () => {
    expect(buildCjkFallbackFonts('linux', ['ko-KR']).slice(0, 5)).toEqual([
      'Noto Sans Mono CJK KR',
      'Noto Sans CJK KR',
      'D2Coding',
      'NanumGothicCoding',
      'Sarasa Mono K'
    ])
    expect(buildCjkFallbackFonts('darwin', ['ko-KR'])[0]).toBe('Apple SD Gothic Neo')
    expect(buildCjkFallbackFonts('win32', ['ko-KR'])[0]).toBe('Malgun Gothic')
  })

  it('orders Traditional Chinese faces first for zh-TW', () => {
    expect(buildCjkFallbackFonts('darwin', ['zh-TW'])).toEqual([
      'PingFang TC',
      'PingFang HK',
      'PingFang SC',
      'Hiragino Sans',
      'Hiragino Kaku Gothic ProN',
      'Apple SD Gothic Neo'
    ])
  })

  it('uses SC, JP, TC, KR order without a CJK locale', () => {
    expect(buildCjkFallbackFonts('win32', ['en-US'])).toEqual([
      'Microsoft YaHei',
      'Yu Gothic',
      'Meiryo',
      'Microsoft JhengHei',
      'Malgun Gothic'
    ])
  })

  it('lists every face exactly once whatever the locale', () => {
    for (const locales of [['ko'], ['ja'], ['zh-CN'], ['zh-TW'], ['en']]) {
      const fonts = buildCjkFallbackFonts('linux', locales)
      expect(new Set(fonts).size).toBe(fonts.length)
      expect(fonts).toHaveLength(15)
    }
  })

  it('falls back to the Linux list for other Unix platforms', () => {
    expect(buildCjkFallbackFonts('freebsd', ['ja'])[0]).toBe('Noto Sans Mono CJK JP')
  })
})
