import type { SettingsSearchEntry } from './settings-search'
import { BROWSER_PANE_SEARCH_ENTRIES as BROWSER_CORE_SEARCH_ENTRIES } from './browser-search'
import { BROWSER_USE_PANE_SEARCH_ENTRIES } from './browser-use-search'

export const BROWSER_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...BROWSER_USE_PANE_SEARCH_ENTRIES,
  ...BROWSER_CORE_SEARCH_ENTRIES
]
