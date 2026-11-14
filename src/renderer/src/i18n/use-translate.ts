import { createContext, useContext } from 'react'
import { getIntlLocale, getTranslationScope, translate } from './i18n'

export type Translate = typeof translate

type TranslationScopeValue = { readonly t: Translate; readonly intlLocale: string }

/** Null outside I18nProvider (detached roots, isolated tests): hooks then fall back to the module functions. */
export const TranslationScopeContext = createContext<TranslationScopeValue | null>(null)

export function getTranslationScopeKey(): string {
  return `${getTranslationScope()}\0${getIntlLocale()}`
}

let current: { key: string; value: TranslationScopeValue } | undefined

// The key is an argument rather than read here, so memoized callers recompute exactly when it changes.
export function translationScopeValue(key: string): TranslationScopeValue {
  if (current?.key !== key) {
    current = {
      key,
      value: {
        // Delegates, so output always equals translate(); only the identity tracks the scope.
        t: (translationKey, fallback, options) => translate(translationKey, fallback, options),
        intlLocale: key.slice(key.lastIndexOf('\0') + 1)
      }
    }
  }
  return current.value
}

/** translate() whose identity changes with the language or loaded resources, so render output tracks them. */
export function useTranslate(): Translate {
  return useContext(TranslationScopeContext)?.t ?? translate
}

/** getIntlLocale() as a render dependency that changes with the UI language. */
export function useIntlLocale(): string {
  return useContext(TranslationScopeContext)?.intlLocale ?? getIntlLocale()
}
