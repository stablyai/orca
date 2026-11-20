import type { SettingsSearchEntry } from '../search/settings-search'
import { getBrowserPaneSearchEntries } from './browser-search'
import { getBrowserUsePaneSearchEntries } from './use/browser-use-search'
import { getBrowserPasswordsSearchEntry } from './passwords/browser-passwords-copy'
import { getBrowserMemorySaverSearchEntry } from './browser-memory-saver-search'
import { getBrowserExtensionsSearchEntry } from './extensions/browser-extensions-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getBrowserPaneCombinedSearchEntries = createLocalizedCatalog(
  (): SettingsSearchEntry[] => [
    ...getBrowserUsePaneSearchEntries(),
    ...getBrowserPaneSearchEntries(),
    getBrowserMemorySaverSearchEntry(),
    getBrowserPasswordsSearchEntry(),
    getBrowserExtensionsSearchEntry()
  ]
)
