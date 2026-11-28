import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from '../search/settings-search'
import { translateSearchKeyword } from '../search/settings-search-keywords'

/** Settings-search entry for the live memory value beside the Resource Manager icon. */
export const getStatusBarMemoryEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  title: translate(
    'auto.components.settings.appearance.search.statusBarMemory.title',
    'Show memory in status bar'
  ),
  description: translate(
    'auto.components.settings.appearance.search.statusBarMemory.description',
    'Show Orca’s app memory next to the Resource Manager icon. Updates every 30 seconds while the window is focused.'
  ),
  keywords: [
    ...translateSearchKeyword(
      'auto.components.settings.appearance.search.896eb53fd4',
      'status bar'
    ),
    ...translateSearchKeyword('auto.components.settings.appearance.search.4355f18ac6', 'memory'),
    ...translateSearchKeyword('auto.components.settings.appearance.search.c690a15849', 'resource')
  ]
}))
