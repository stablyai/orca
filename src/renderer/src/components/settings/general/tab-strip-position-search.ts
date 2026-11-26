import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from '../search/settings-search'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getTabStripPositionSearchEntry = createLocalizedCatalog((): SettingsSearchEntry => ({
  title: translate(
    'auto.components.settings.general.tab.strip.position.search.3e515161c1',
    'Tab position'
  ),
  description: translate(
    'auto.components.settings.general.tab.strip.position.search.ced44863c5',
    'Show tabs in a strip above each split, or in a vertical list on its left.'
  ),
  keywords: [
    ...translateSearchKeyword('auto.components.settings.general.search.2a254b725e', 'tab'),
    ...translateSearchKeyword(
      'auto.components.settings.general.tab.strip.position.search.2f44a02656',
      'vertical tabs'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.general.tab.strip.position.search.69724f255a',
      'side'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.general.tab.strip.position.search.ce60fea1b4',
      'left'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.general.tab.strip.position.search.0b8635b33f',
      'top'
    )
  ]
}))
