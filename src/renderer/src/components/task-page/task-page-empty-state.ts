import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export type RepoBackedTaskEmptyStateProvider = 'github' | 'gitlab'

export type RepoBackedTaskEmptyState = {
  title: string
  description: string
}

export function getRepoBackedTaskEmptyState(
  args: {
    provider: RepoBackedTaskEmptyStateProvider
    selectedRepoCount: number
    gitlabView?: 'issues' | 'mrs' | 'todos'
  },
  t: Translate = translate
): RepoBackedTaskEmptyState {
  if (args.selectedRepoCount === 0) {
    return {
      title: t(
        'auto.components.taskPageEmptyState.noProjectSourcesTitle',
        'No project sources selected'
      ),
      description: t(
        'auto.components.taskPageEmptyState.noProjectSourcesDescription',
        'Select at least one project source so Orca knows which host/account to fetch tasks from.'
      )
    }
  }
  if (args.provider === 'github') {
    return {
      title: t(
        'auto.components.taskPageEmptyState.noMatchingGitHubWorkTitle',
        'No matching GitHub work'
      ),
      description: t(
        'auto.components.taskPageEmptyState.changeQueryDescription',
        'Change the query or clear it.'
      )
    }
  }
  switch (args.gitlabView) {
    case 'issues':
      return {
        title: t('auto.components.taskPageEmptyState.noGitLabIssuesTitle', 'No GitLab issues'),
        description: t(
          'auto.components.taskPageEmptyState.noGitLabIssuesDescription',
          'No GitLab issues match this filter.'
        )
      }
    case 'mrs':
      return {
        title: t('auto.components.taskPageEmptyState.noGitLabMrsTitle', 'No GitLab merge requests'),
        description: t(
          'auto.components.taskPageEmptyState.noGitLabMrsDescription',
          'No GitLab MRs match this filter.'
        )
      }
    case 'todos':
    case undefined:
      return {
        title: t('auto.components.taskPageEmptyState.noGitLabWorkTitle', 'No GitLab work'),
        description: t(
          'auto.components.taskPageEmptyState.noGitLabWorkDescription',
          'No GitLab work matches this filter.'
        )
      }
  }
}
