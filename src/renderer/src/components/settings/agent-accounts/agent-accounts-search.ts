import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from '../search/settings-search-keywords'

/** Agent accounts in Orca Cloud builds: this computer and your hosts. Orca Cloud's own sign-ins
 *  are their own page in the Orca Cloud group (getCloudAgentSignInsSearchEntries). */
export const getAgentAccountsSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('settings.agentAccounts.searchTitle', 'Agent accounts'),
    description: translate(
      'settings.agentAccounts.hubSearchDescriptionHosts',
      'Where Claude and Codex are signed in on this computer and your hosts.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.agentAccounts.search.signIn', 'sign in'),
      ...translateSearchKeyword('settings.agentAccounts.search.hosts', 'hosts')
    ]
  }
])

/** Settings › Orca Cloud › Cloud agent sign-ins: Claude and ChatGPT sign-ins for cloud workspaces. */
export const getCloudAgentSignInsSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('settings.cloudAgentSignIns.searchTitle', 'Cloud agent sign-ins'),
    description: translate(
      'settings.cloudAgentSignIns.searchDescription',
      'Set up Claude and Codex once for every cloud workspace: your Claude subscription or ChatGPT sign-in.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.agentAccounts.search.subscription', 'subscription'),
      ...translateSearchKeyword('settings.agentAccounts.search.signIn', 'sign in'),
      ...translateSearchKeyword('settings.agentAccounts.search.chatgpt', 'chatgpt'),
      ...translateSearchKeyword('settings.agentAccounts.search.setupToken', 'setup-token'),
      ...translateSearchKeyword('settings.cloudAgentSignIns.search.renew', 'renew'),
      ...translateSearchKeyword('settings.cloudAgentSignIns.search.agentAccounts', 'agent accounts')
    ]
  }
])
