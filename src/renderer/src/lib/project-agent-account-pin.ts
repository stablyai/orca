import type { AppState } from '@/store'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'

export type ProjectPinAgent = 'claude' | 'codex'

/** The saved account (host or WSL) a project pins an agent's sessions to, whatever is selected;
 *  null when none or when that account is gone. */
export function pinnedProjectAccountId(
  state: Pick<AppState, 'repos' | 'settings'>,
  agent: ProjectPinAgent,
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId) {
    return null
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const repo = state.repos.find((candidate) => candidate.id === repoId)
  const accountId = agent === 'claude' ? repo?.claudeAccountId : repo?.codexAccountId
  if (!accountId) {
    return null
  }
  const saved =
    agent === 'claude'
      ? state.settings?.claudeManagedAccounts.some((account) => account.id === accountId)
      : state.settings?.codexManagedAccounts.some((account) => account.id === accountId)
  return saved ? accountId : null
}

/** A pinned project relaunches its sessions on its account, so a selection switch cannot move them. */
export function isPinnedProject(
  state: Pick<AppState, 'repos' | 'settings'>,
  agent: ProjectPinAgent,
  worktreeId: string
): boolean {
  return pinnedProjectAccountId(state, agent, worktreeId) !== null
}
