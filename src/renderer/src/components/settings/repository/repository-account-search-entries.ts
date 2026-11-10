import type { Repo } from '../../../../../shared/repo-types'
import type { SettingsSearchEntry } from '../search/settings-search'
import type { Translate } from '@/i18n/use-translate'
import { searchKeywordTranslator } from '../search/settings-search-keywords'

export function getRepositoryGitHubAccountSearchEntry(
  repo: Repo,
  t: Translate
): SettingsSearchEntry {
  const translateSearchKeyword = searchKeywordTranslator(t)
  return {
    title: t('auto.components.settings.repository.search.eefc3e51ef', 'GitHub account'),
    description: t(
      'auto.components.settings.repository.search.githubAccountDescription',
      'Bind a keyring gh login for this project’s GitHub API calls.'
    ),
    keywords: [
      repo.displayName,
      ...translateSearchKeyword('auto.components.settings.repository.search.9dc60d7f6d', 'github'),
      ...translateSearchKeyword(
        'auto.components.settings.repository.search.githubAccountKeyword',
        'github account'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.repository.search.ghAccount',
        'gh account'
      ),
      ...translateSearchKeyword('auto.components.settings.repository.search.login', 'login'),
      ...translateSearchKeyword('auto.components.settings.repository.search.token', 'token')
    ]
  }
}

export function getRepositoryClaudeAccountSearchEntry(
  repo: Repo,
  t: Translate
): SettingsSearchEntry {
  const translateSearchKeyword = searchKeywordTranslator(t)
  return {
    title: t('auto.components.settings.repository.search.claudeAccount', 'Claude Account'),
    description: t(
      'auto.components.settings.repository.search.claudeAccountDescription',
      'Choose which Claude account starts in this project.'
    ),
    keywords: [
      repo.displayName,
      ...translateSearchKeyword(
        'auto.components.settings.repository.search.claudeAccountKeyword',
        'claude account'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.repository.search.claudeAccountsKeyword',
        'claude accounts'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.repository.search.accountsKeyword',
        'accounts'
      )
    ]
  }
}
