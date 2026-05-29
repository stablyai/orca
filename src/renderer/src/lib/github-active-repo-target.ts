import type { AppState } from '@/store/types'
import type { GitHubRepoTarget } from '../../../shared/github-project-types'

export function activeGitHubRepoTargetFromState(
  state: Pick<AppState, 'activeRepoId' | 'repos'>
): GitHubRepoTarget {
  const repo = state.activeRepoId ? state.repos.find((r) => r.id === state.activeRepoId) : null
  if (!repo) {
    return {}
  }
  return { repoPath: repo.path, connectionId: repo.connectionId ?? null }
}
