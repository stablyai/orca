import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getContextPressureSearchEntry(): SettingsSearchEntry {
  return {
    title: translate(
      'auto.components.settings.experimental.search.contextPressure.title',
      'Context pressure'
    ),
    description: translate(
      'auto.components.settings.experimental.search.contextPressure.description',
      'Traffic-light indicator for agent context-window usage, with configurable thresholds and soft token limits.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.0d24759f14',
        'experimental'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.contextPressure.context',
        'context'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.contextPressure.tokens',
        'tokens'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.contextPressure.usage',
        'usage'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.contextPressure.limit',
        'limit'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.contextPressure.window',
        'window'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.contextPressure.pressure',
        'pressure'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.experimental.search.contextPressure.compaction',
        'compaction'
      )
    ],
    targetSectionId: 'experimental-context-pressure'
  }
}
