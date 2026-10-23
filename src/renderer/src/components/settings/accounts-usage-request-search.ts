import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { USAGE_REQUEST_PROVIDERS } from '../../../../shared/usage-request-policy'
import { translateSearchKeyword } from './settings-search-keywords'

export const getAccountsUsageRequestSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('settings.usageRequests.title', 'Usage requests'),
    description: translate(
      'settings.usageRequests.searchDescription',
      'Control automatic and manual provider usage checks on the selected host.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.cursor.kw.usage',
        'usage'
      ),
      ...translateSearchKeyword('settings.usageRequests.keywords.requests', 'requests'),
      ...translateSearchKeyword('settings.usageRequests.keywords.polling', 'polling'),
      ...translateSearchKeyword('auto.components.settings.accounts.search.c759741d77', 'quota'),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.e949b08ffb',
        'rate limit'
      ),
      ...translateSearchKeyword('auto.components.settings.agents.search.60393e1b17', 'disable'),
      ...translateSearchKeyword('auto.components.settings.TerminalPane.ab20575a8a', 'off'),
      ...translateSearchKeyword('settings.usageRequests.keywords.fetch', 'fetch'),
      ...translateSearchKeyword(
        'auto.components.settings.accounts.search.86edc96bc9',
        'status bar'
      ),
      ...USAGE_REQUEST_PROVIDERS
    ]
  }
])
