import { afterEach, describe, expect, it } from 'vitest'
import { SUPPORTED_UI_LOCALES } from '../../../../../shared/i18n/ui-locale'
import { MONACO_UI_LOCALE_PACKS } from './monaco-ui-locale'

declare global {
  var _VSCODE_NLS_LANGUAGE: string | undefined
  var _VSCODE_NLS_MESSAGES: string[] | undefined
}

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
})
