import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { DEFAULT_SEARCH_ENGINE, type SearchEngine } from '../../../../../shared/browser-url'
import {
  buildBrowserAddressBarSuggestions,
  type BrowserAddressBarSuggestion
} from './browser-address-bar-suggestions'

export function useBrowserAddressBarSuggestionsBuilder(): (
  query: string,
  inline: true | string | null
) => BrowserAddressBarSuggestion[] {
  const browserUrlHistory = useAppStore((s) => s.browserUrlHistory)
  const workspaceDocHistory = useAppStore((s) => s.workspaceDocHistory)
  const browserDefaultSearchEngine = useAppStore((s) => s.browserDefaultSearchEngine)
  const browserKagiSessionLink = useAppStore((s) => s.browserKagiSessionLink)

  const searchEngine: SearchEngine =
    (browserDefaultSearchEngine as SearchEngine | null) ?? DEFAULT_SEARCH_ENGINE

  return useCallback(
    (query: string, inline: true | string | null) =>
      buildBrowserAddressBarSuggestions({
        browserUrlHistory,
        workspaceDocHistory,
        kagiSessionLink: browserKagiSessionLink,
        searchEngine,
        value: query,
        inline
      }),
    [browserUrlHistory, workspaceDocHistory, searchEngine, browserKagiSessionLink]
  )
}
