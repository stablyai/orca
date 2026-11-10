import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import type { SettingsSearchEntry } from '../search/settings-search'
import { translateSearchKeyword } from '../search/settings-search-keywords'

type TabSizingSearchEntries = {
  mode: SettingsSearchEntry
  minWidth: SettingsSearchEntry
  maxWidth: SettingsSearchEntry
}

// Why: the General group filter and each rendered row must match the same
// query, so TabSizingSettings reads its search metadata from here too.
export const getTabSizingSearchEntryMap = createLocalizedCatalog((): TabSizingSearchEntries => {
  const sharedKeywords = [
    ...translateSearchKeyword('auto.components.settings.general.search.2a254b725e', 'tab'),
    ...translateSearchKeyword('auto.components.settings.general.search.tab_width', 'width'),
    ...translateSearchKeyword('auto.components.settings.general.search.tab_size', 'size'),
    ...translateSearchKeyword('auto.components.settings.general.search.tab_sizing', 'sizing')
  ]
  return {
    mode: {
      title: translate('auto.components.settings.TabSizingSettings.title', 'Tab Sizing'),
      description: translate(
        'auto.components.settings.TabSizingSettings.search_description',
        'Fit, shrink, or fixed-width tabs.'
      ),
      keywords: [
        ...sharedKeywords,
        ...translateSearchKeyword('auto.components.settings.general.search.tab_fit', 'fit'),
        ...translateSearchKeyword('auto.components.settings.general.search.tab_shrink', 'shrink'),
        ...translateSearchKeyword('auto.components.settings.general.search.tab_fixed', 'fixed'),
        ...translateSearchKeyword('auto.components.settings.general.search.tab_compact', 'compact')
      ]
    },
    minWidth: {
      title: translate('auto.components.settings.TabSizingSettings.min_width', 'Tab Min Width'),
      description: translate(
        'auto.components.settings.TabSizingSettings.min_width_description',
        'Tabs never get narrower than this; the tab bar scrolls instead.'
      ),
      keywords: [
        ...sharedKeywords,
        ...translateSearchKeyword('auto.components.settings.general.search.tab_narrow', 'narrow')
      ]
    },
    maxWidth: {
      title: translate('auto.components.settings.TabSizingSettings.max_width', 'Tab Max Width'),
      description: translate(
        'auto.components.settings.TabSizingSettings.max_width_description',
        'Tabs never get wider than this.'
      ),
      keywords: [
        ...sharedKeywords,
        ...translateSearchKeyword('auto.components.settings.general.search.tab_compact', 'compact')
      ]
    }
  }
})

export function getTabSizingSearchEntries(): SettingsSearchEntry[] {
  const { mode, minWidth, maxWidth } = getTabSizingSearchEntryMap()
  return [mode, minWidth, maxWidth]
}
