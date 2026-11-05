import type { AppState } from '@/store'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'

/** The saved Claude account a project pins its sessions to, whatever is selected; null when none. */
export function pinnedClaudeAccountId(
  state: Pick<AppState, 'repos' | 'settings'>,
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId) {
    return null
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const accountId = state.repos.find((repo) => repo.id === repoId)?.claudeAccountId
  return accountId &&
    state.settings?.claudeManagedAccounts.some((account) => account.id === accountId)
    ? accountId
    : null
}

/** A pinned project relaunches its sessions on its account, so a selection switch cannot move them. */
export function isPinnedClaudeProject(
  state: Pick<AppState, 'repos' | 'settings'>,
  worktreeId: string
): boolean {
  return pinnedClaudeAccountId(state, worktreeId) !== null
}
