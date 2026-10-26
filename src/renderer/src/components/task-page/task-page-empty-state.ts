import { translate } from '@/i18n/i18n'

export type RepoBackedTaskEmptyStateProvider = 'github' | 'gitlab'

export type RepoBackedTaskEmptyState = {
  title: string
  description: string
}

export function getRepoBackedTaskEmptyState(args: {
  provider: RepoBackedTaskEmptyStateProvider
  selectedRepoCount: number
  gitlabView?: 'issues' | 'mrs' | 'todos'
}): RepoBackedTaskEmptyState {
  if (args.selectedRepoCount === 0) {
    return {
      title: translate(
        'auto.components.taskPageEmptyState.noProjectSourcesTitle',
        'No project sources selected'
      ),
      description: translate(
        'auto.components.taskPageEmptyState.noProjectSourcesDescription',
        'Select at least one project source so Orca knows which host/account to fetch tasks from.'
      )
    }
  }
  if (args.provider === 'github') {
    return {
      title: translate(
        'auto.components.taskPageEmptyState.noMatchingGitHubWorkTitle',
        'No matching GitHub work'
      ),
      description: translate(
        'auto.components.taskPageEmptyState.changeQueryDescription',
        'Change the query or clear it.'
      )
    }
  }
  switch (args.gitlabView) {
    case 'issues':
      return {
        title: translate(
          'auto.components.taskPageEmptyState.noGitLabIssuesTitle',
          'No GitLab issues'
        ),
        description: translate(
          'auto.components.taskPageEmptyState.noGitLabIssuesDescription',
          'No GitLab issues match this filter.'
        )
      }
    case 'mrs':
      return {
        title: translate(
          'auto.components.taskPageEmptyState.noGitLabMrsTitle',
          'No GitLab merge requests'
        ),
        description: translate(
          'auto.components.taskPageEmptyState.noGitLabMrsDescription',
          'No GitLab MRs match this filter.'
        )
      }
    case 'todos':
    case undefined:
      return {
        title: translate('auto.components.taskPageEmptyState.noGitLabWorkTitle', 'No GitLab work'),
        description: translate(
          'auto.components.taskPageEmptyState.noGitLabWorkDescription',
          'No GitLab work matches this filter.'
        )
      }
  }
}
