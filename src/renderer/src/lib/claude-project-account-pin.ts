import type { AppState } from '@/store'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'

/** A project pinned to a saved Claude account relaunches its terminals on it, whatever is selected. */
export function isPinnedClaudeProject(
  state: Pick<AppState, 'repos' | 'settings'>,
  worktreeId: string
): boolean {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const accountId = state.repos.find((repo) => repo.id === repoId)?.claudeAccountId
  return Boolean(
    accountId && state.settings?.claudeManagedAccounts.some((account) => account.id === accountId)
  )
}
