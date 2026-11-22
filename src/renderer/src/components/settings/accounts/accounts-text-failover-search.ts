import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export const getAccountsTextFailoverSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'components.settings.accounts.textFailover.title',
      'Retry AI-generated text on another account after quota limits'
    ),
    description: translate(
      'components.settings.accounts.textFailover.description',
      'When a subscription limit stops branch or workspace names, commit messages, pull request details or Jira titles, Orca retries the same request on up to two other saved Claude or Codex accounts that still have room. The model and prompt stay the same, and the selected account does not change.'
    ),
    keywords: [
      ...translateSearchKeyword('components.settings.accounts.textFailover.kw.account', 'account'),
      ...translateSearchKeyword('components.settings.accounts.textFailover.kw.quota', 'quota'),
      ...translateSearchKeyword(
        'components.settings.accounts.textFailover.kw.usageLimit',
        'usage limit'
      ),
      ...translateSearchKeyword('components.settings.accounts.textFailover.kw.retry', 'retry'),
      ...translateSearchKeyword(
        'components.settings.accounts.textFailover.kw.commitMessage',
        'commit message'
      ),
      ...translateSearchKeyword(
        'components.settings.accounts.textFailover.kw.branchName',
        'branch name'
      )
    ]
  }
])
