import { useSyncExternalStore } from 'react'
import {
  getTranslationResourceVersion,
  subscribeTranslationResourceVersion
} from './translation-resource-version'

/** Memoized components that call translate() need this to re-render on language or catalog changes. */
export function useUiLanguageRevision(): number {
  return useSyncExternalStore(
    subscribeTranslationResourceVersion,
    getTranslationResourceVersion,
    getTranslationResourceVersion
  )
}
