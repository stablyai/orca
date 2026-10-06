import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from './settings-search-keywords'

export const getAccountsCopilotSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.accounts.search.copilot.title',
      'GitHub Copilot Usage'
    ),
    description: translate(
      'auto.components.settings.accounts.search.copilot.description',
      'Uses your existing Copilot login to show monthly premium request usage.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.copilot.kw.copilot',
        'copilot'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.copilot.kw.github',
        'github'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.copilot.kw.premium',
        'premium requests'
      ),
      ...translateSearchKeyword('auto.components.settings.accounts.search.a9f3d7b5c8', 'login'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.86edc96bc9', 'status bar')
    ]
  }
])
