import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getAccountsTextRecoverySearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'settings.accounts.textRecovery.label',
      'Retry AI-generated text on another account after quota limits'
    ),
    keywords: [
      ...translateSearchKeyword('settings.accounts.textRecovery.keywords.account', 'account'),
      ...translateSearchKeyword('settings.accounts.textRecovery.keywords.quota', 'quota'),
      ...translateSearchKeyword('settings.accounts.textRecovery.keywords.failover', 'failover'),
      ...translateSearchKeyword('settings.accounts.textRecovery.keywords.naming', 'naming'),
      ...translateSearchKeyword('settings.accounts.textRecovery.keywords.branch', 'branch'),
      ...translateSearchKeyword('settings.accounts.textRecovery.keywords.workspace', 'workspace'),
      ...translateSearchKeyword('settings.accounts.textRecovery.keywords.commit', 'commit message'),
      ...translateSearchKeyword('settings.accounts.textRecovery.keywords.pr', 'pull request'),
      ...translateSearchKeyword('settings.accounts.textRecovery.keywords.jira', 'Jira'),
      ...translateSearchKeyword('settings.accounts.textRecovery.keywords.chat', 'chat name')
    ]
  }
])
