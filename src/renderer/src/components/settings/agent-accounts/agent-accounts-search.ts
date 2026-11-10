import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getAgentAccountsSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('settings.agentAccounts.searchTitle', 'Agent accounts'),
    description: translate(
      'settings.agentAccounts.searchDescription',
      'Use your Claude and ChatGPT accounts in every cloud workspace.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.agentAccounts.search.subscription', 'subscription'),
      ...translateSearchKeyword('settings.agentAccounts.search.signIn', 'sign in'),
      ...translateSearchKeyword('settings.agentAccounts.search.chatgpt', 'chatgpt'),
      ...translateSearchKeyword('settings.agentAccounts.search.setupToken', 'setup-token')
    ]
  }
])
