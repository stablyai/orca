import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { SettingsSearchEntry } from '../../search/settings-search'
import type { Translate } from '@/i18n/use-translate'
import { searchKeywords } from '../../search/settings-search-keywords'

export function getRepositoryGitExecutionSearchEntry(
  repo: Repo,
  t: Translate
): SettingsSearchEntry {
  return {
    title: t('components.settings.ssh.gitExecution.title', 'Git execution host'),
    description: t(
      'components.settings.repository.gitExecution.description',
      'Choose where Orca runs source-control and GitHub UI actions for this project.'
    ),
    keywords: searchKeywords(
      [repo.displayName, repo.path, 'git', 'github', 'ssh', 'sbx', 'credentials', 'push'],
      t
    )
  }
}
