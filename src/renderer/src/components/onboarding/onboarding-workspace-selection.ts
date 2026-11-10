import { selectKnownWorktreeById } from '@/store/workspaces/selection/known-worktree-selection'
import type { AppState } from '@/store/types'

export function selectOnboardingWorkspaceId(state: AppState): string | null {
  return selectKnownWorktreeById(state, state.activeWorktreeId) ? state.activeWorktreeId : null
}
