import { afterEach, describe, expect, it, vi } from 'vitest'
import { SUPPORTED_UI_LOCALES } from '../../../../../shared/i18n/ui-locale'
import { loadMonacoUiLocalePack, MONACO_UI_LOCALE_PACKS } from './monaco-ui-locale'

// Monaco names its Chinese and Portuguese packs after regions; a wrong name leaves the editor in English without an error.
const MONACO_LANGUAGE_FOR_UI_LOCALE: Record<string, string> = {
  zh: 'zh-cn',
  'zh-Hant': 'zh-tw',
  ko: 'ko',
  ja: 'ja',
  es: 'es',
  fr: 'fr',
  pt: 'pt-br',
  ru: 'ru',
  tr: 'tr',
  de: 'de'
}

describe('Monaco UI locale packs', () => {
  afterEach(() => {
    vi.useRealTimers()
    globalThis._VSCODE_NLS_LANGUAGE = undefined
    globalThis._VSCODE_NLS_MESSAGES = undefined
  })

  it('has a pack that loads for every UI locale except English', async () => {
    const translated = SUPPORTED_UI_LOCALES.filter((locale) => locale !== 'en')
    expect(Object.keys(MONACO_UI_LOCALE_PACKS).sort()).toEqual([...translated].sort())
    for (const locale of translated) {
      await MONACO_UI_LOCALE_PACKS[locale]()
      expect(globalThis._VSCODE_NLS_LANGUAGE, locale).toBe(MONACO_LANGUAGE_FOR_UI_LOCALE[locale])
      expect(globalThis._VSCODE_NLS_MESSAGES?.length, locale).toBeGreaterThan(1000)
    }
  })

  it('opens Monaco in English when the pack misses the bound, and a late pack leaves no trace', async () => {
    vi.useFakeTimers()
    let land = (): void => {}
    const latePack = (): Promise<void> =>
      new Promise((resolve) => {
        land = () => {
          globalThis._VSCODE_NLS_LANGUAGE = 'zh-cn'
          globalThis._VSCODE_NLS_MESSAGES = ['复制']
          resolve()
        }
      })

    const installation = loadMonacoUiLocalePack(latePack, 5000)
    await vi.advanceTimersByTimeAsync(5000)
    await installation

    land()
    await vi.runAllTimersAsync()
    expect(globalThis._VSCODE_NLS_LANGUAGE).toBeUndefined()
    expect(globalThis._VSCODE_NLS_MESSAGES).toBeUndefined()
  })
})
