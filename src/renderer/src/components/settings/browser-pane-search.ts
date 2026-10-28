import type { SettingsSearchEntry } from './settings-search'
import { getBrowserPaneSearchEntries } from './browser-search'
import { getBrowserUsePaneSearchEntries } from './browser-use-search'
import { getBrowserPasswordsSearchEntry } from './browser-passwords-copy'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getBrowserPaneCombinedSearchEntries = createLocalizedCatalog(
  (): SettingsSearchEntry[] => [
    ...getBrowserUsePaneSearchEntries(),
    ...getBrowserPaneSearchEntries(),
    getBrowserPasswordsSearchEntry()
  ]
)
