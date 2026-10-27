import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getFitTabsToTitlesSearchEntry(): SettingsSearchEntry {
  return {
    title: translate(
      'auto.components.settings.experimental.search.fitTabsToTitles.title',
      'Fit tabs to titles'
    ),
    description: translate(
      'auto.components.settings.experimental.search.fitTabsToTitles.description',
      'Size tabs to their titles instead of a fixed width.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.fitTabsToTitles.tab',
        'tab'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.fitTabsToTitles.tabs',
        'tabs'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.fitTabsToTitles.width',
        'width'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.fitTabsToTitles.titleKeyword',
        'title'
      )
    ]
  }
}
