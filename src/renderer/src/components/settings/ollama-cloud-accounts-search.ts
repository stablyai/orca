import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getAccountsOllamaSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.accounts.search.ollama.title', 'Ollama Cloud'),
    description: translate(
      'auto.components.settings.accounts.search.ollama.description',
      'Track Ollama cloud subscription usage. Save the API key from ollama.com.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.ollama.kw.ollama',
        'ollama'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.ollama.kw.cloud',
        'cloud'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.ollama.kw.usage',
        'usage'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.ollama.kw.rateLimit',
        'rate limit'
      )
    ]
  }
])
