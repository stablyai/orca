import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getAgentApiKeysSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('settings.agentApiKeys.searchTitle', 'Agent API keys'),
    description: translate(
      'auto.components.settings.agentApiKeys.search.description',
      'Give agents an API key on every host or only some, without signing in on each machine.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.agentApiKeys.search.apiKey', 'api key'),
      ...translateSearchKeyword('auto.components.settings.agentApiKeys.search.secret', 'secret'),
      ...translateSearchKeyword('auto.components.settings.agentApiKeys.search.env', 'environment'),
      ...translateSearchKeyword('auto.components.settings.agentApiKeys.search.bedrock', 'bedrock')
    ]
  }
])
