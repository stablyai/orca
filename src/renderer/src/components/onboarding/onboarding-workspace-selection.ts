import { selectKnownWorktreeById } from '@/store/selectors'
import type { AppState } from '@/store/types'

export function selectOnboardingWorkspaceId(state: AppState): string | null {
  return selectKnownWorktreeById(state, state.activeWorktreeId) ? state.activeWorktreeId : null
}
