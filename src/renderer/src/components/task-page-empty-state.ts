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
      title: 'No project sources selected',
      description:
        'Select at least one project source so Orca knows which host/account to fetch tasks from.'
    }
  }
  if (args.provider === 'github') {
    return {
      title: 'No matching GitHub work',
      description: 'Change the query or clear it.'
    }
  }
  switch (args.gitlabView) {
    case 'issues':
      return {
        title: 'No GitLab issues',
        description: 'No GitLab issues match this filter.'
      }
    case 'mrs':
      return {
        title: 'No GitLab merge requests',
        description: 'No GitLab MRs match this filter.'
      }
    default:
      return {
        title: 'No GitLab work',
        description: 'No GitLab work matches this filter.'
      }
  }
}
