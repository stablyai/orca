import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getTabStripPlacementSearchEntry = createLocalizedCatalog(() => ({
  title: translate('auto.components.settings.TabStripPlacementControl.title', 'Tab Placement'),
  description: translate(
    'auto.components.settings.TabStripPlacementControl.description',
    'Show tabs in the top strip, or in a resizable panel on the right.'
  ),
  keywords: [
    ...translateSearchKeyword(
      'auto.components.settings.TabStripPlacementControl.keywordVerticalTabs',
      'vertical tabs'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.TabStripPlacementControl.keywordSidePanel',
      'side panel'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.TabStripPlacementControl.keywordTabStrip',
      'tab strip'
    )
  ]
}))
