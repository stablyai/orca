import type { AppState } from '@/store/types'

type WorkspaceTabActivationTarget = {
  worktreeId: string
  groupId: string
  tabId: string
}

// Callers resolve the target and own workspace activation and content-specific effects.
export function activateWorkspaceTab(
  state: Pick<AppState, 'focusGroup' | 'activateTab'>,
  target: WorkspaceTabActivationTarget
): void {
  state.focusGroup(target.worktreeId, target.groupId)
  state.activateTab(target.tabId, { worktreeId: target.worktreeId })
}
