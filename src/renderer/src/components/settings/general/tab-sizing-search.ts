import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getTabSizingSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.TabSizingSettings.title', 'Tab Sizing'),
    description: translate(
      'auto.components.settings.TabSizingSettings.search_description',
      'Fit, shrink, or fixed-width tabs.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.2a254b725e', 'tab'),
      ...translateSearchKeyword('auto.components.settings.general.search.tab_width', 'width'),
      ...translateSearchKeyword('auto.components.settings.general.search.tab_sizing', 'sizing'),
      ...translateSearchKeyword('auto.components.settings.general.search.tab_fit', 'fit'),
      ...translateSearchKeyword('auto.components.settings.general.search.tab_shrink', 'shrink'),
      ...translateSearchKeyword('auto.components.settings.general.search.tab_fixed', 'fixed'),
      ...translateSearchKeyword('auto.components.settings.general.search.tab_compact', 'compact')
    ]
  },
  {
    title: translate('auto.components.settings.TabSizingSettings.min_width', 'Tab Min Width'),
    description: translate(
      'auto.components.settings.TabSizingSettings.min_width_description',
      'Tabs never get narrower than this; the tab bar scrolls instead.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.2a254b725e', 'tab'),
      ...translateSearchKeyword('auto.components.settings.general.search.tab_width', 'width'),
      ...translateSearchKeyword('auto.components.settings.general.search.tab_sizing', 'sizing'),
      ...translateSearchKeyword('auto.components.settings.general.search.tab_narrow', 'narrow')
    ]
  },
  {
    title: translate('auto.components.settings.TabSizingSettings.max_width', 'Tab Max Width'),
    description: translate(
      'auto.components.settings.TabSizingSettings.max_width_description',
      'Tabs never get wider than this.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.2a254b725e', 'tab'),
      ...translateSearchKeyword('auto.components.settings.general.search.tab_width', 'width'),
      ...translateSearchKeyword('auto.components.settings.general.search.tab_sizing', 'sizing'),
      ...translateSearchKeyword('auto.components.settings.general.search.tab_compact', 'compact')
    ]
  }
])
