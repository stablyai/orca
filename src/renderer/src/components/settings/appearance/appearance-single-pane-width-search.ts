import type { SettingsSearchEntry } from '../search/settings-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getSinglePaneWidthEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  {
    title: translate(
      'auto.components.settings.appearance.search.singlePaneWidth',
      'Single Pane Width'
    ),
    description: translate(
      'auto.components.settings.appearance.search.singlePaneWidthSummary',
      'Maximum width for a tab with no splits — terminal, browser, editor or preview — centered in the window.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.appearance.search.kwWidth', 'width'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.kwMaxWidth',
        'max width'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.kwCentered',
        'centered'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.kwSingle', 'single'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.kwWide', 'wide'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.kwUnsplit', 'unsplit'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.kwPane', 'pane'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.kwBrowser', 'browser'),
      ...translateSearchKeyword('auto.components.settings.appearance.search.kwEditor', 'editor'),
      // Kept so a user who has always searched "terminal" for this still lands on it.
      ...translateSearchKeyword('auto.components.settings.appearance.search.kwTerminal', 'terminal')
    ]
  }
])
