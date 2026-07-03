import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getAgentCacheTimerSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.general.search.1e0f28c6f1', 'Prompt Cache Timer'),
    description: translate(
      'auto.components.settings.general.search.40c9585e43',
      'Countdown timer showing time until prompt cache expires (Claude agents).'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.b2601a778c', 'cache'),
      ...translateSearchKeyword('auto.components.settings.general.search.939b80f5fd', 'timer'),
      ...translateSearchKeyword('auto.components.settings.general.search.0efc9d96ad', 'prompt'),
      ...translateSearchKeyword('auto.components.settings.general.search.585beac3f8', 'ttl'),
      ...translateSearchKeyword('auto.components.settings.general.search.95b63edde7', 'claude'),
      ...translateSearchKeyword('auto.components.settings.general.search.660528b048', 'cost'),
      ...translateSearchKeyword('auto.components.settings.general.search.3462308bd3', 'tokens')
    ]
  }
])
