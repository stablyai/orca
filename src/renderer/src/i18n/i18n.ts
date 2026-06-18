import i18next, { type i18n as I18nInstance, type TOptions } from 'i18next'
import { initReactI18next } from 'react-i18next'

import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'
import { isPseudoLocalizationLocale, pseudoLocalizeString } from './pseudo-localization'
import { DEFAULT_LOCALE, resolveUiLocale } from './supported-languages'
import type { UiLanguage } from '../../../shared/ui-language'

export const i18n: I18nInstance = i18next.createInstance()

void i18n.use(initReactI18next).init({
  fallbackLng: DEFAULT_LOCALE,
  lng: DEFAULT_LOCALE,
  resources: {
    en: {
      translation: en
    },
    zh: {
      translation: zh
    },
    ko: {
      translation: ko
    },
    ja: {
      translation: ja
    },
    es: {
      translation: es
    }
  },
  interpolation: {
    escapeValue: false
  },
  react: {
    useSuspense: false
  }
})

export function translate(key: string, fallback: string, options?: TOptions): string {
  const value = i18n.t(key, { defaultValue: fallback, ...options })
  return isPseudoLocalizationLocale(i18n.language) ? pseudoLocalizeString(value) : value
}

export async function setRendererUiLanguage(language: UiLanguage): Promise<void> {
  const locale = resolveUiLocale(language)
  if (i18n.language !== locale) {
    await i18n.changeLanguage(locale)
  }
}
