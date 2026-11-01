import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

// Why: the settings row filters on these same terms, and reading them out of the navigation
// array by index silently bound the row to whichever entry a later insertion shifted into place.
export const AUTO_HIDE_SINGLE_TAB_STRIP_SEARCH_ENTRY = createLocalizedCatalog(() => ({
  title: translate(
    'auto.components.settings.general.search.autoHideSingleTabStrip',
    'Hide the tab bar when a pane has one tab'
  ),
  description: translate(
    'auto.components.settings.general.search.autoHideSingleTabStripDescription',
    'Collapse the tab bar until you hover the top edge of the pane.'
  ),
  keywords: [
    ...translateSearchKeyword('auto.components.settings.general.search.2a254b725e', 'tab'),
    ...translateSearchKeyword(
      'auto.components.settings.general.search.autoHideSingleTabStripKeywordBar',
      'tab bar'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.general.search.autoHideSingleTabStripKeywordHide',
      'hide'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.general.search.autoHideSingleTabStripKeywordAutoHide',
      'auto hide'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.general.search.autoHideSingleTabStripKeywordSingle',
      'single'
    ),
    ...translateSearchKeyword(
      'auto.components.settings.general.search.autoHideSingleTabStripKeywordStrip',
      'strip'
    )
  ]
}))
