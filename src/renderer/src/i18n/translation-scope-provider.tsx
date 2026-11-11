import { useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { subscribeTranslationScope } from './i18n'
import {
  getTranslationScopeKey,
  TranslationScopeContext,
  translationScopeValue
} from './use-translate'

/** Feeds useTranslate()/useIntlLocale(); detached React roots need their own. */
export function TranslationScopeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const scopeKey = useSyncExternalStore(
    subscribeTranslationScope,
    getTranslationScopeKey,
    getTranslationScopeKey
  )
  const value = useMemo(() => translationScopeValue(scopeKey), [scopeKey])
  return (
    <TranslationScopeContext.Provider value={value}>{children}</TranslationScopeContext.Provider>
  )
}
