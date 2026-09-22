import { captureEmptyTerminalTabRetirement } from '../../../../shared/empty-terminal-tab-retirement'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import type { AppState } from '../types'
import type { TerminalTabRetirementPlan } from '../slices/terminal-tab-retirement'

export function requestEmptyTerminalTabRetirement(
  state: AppState,
  tabId: string,
  plan: TerminalTabRetirementPlan,
  reason: string
): void {
  if (
    typeof window === 'undefined' ||
    reason !== 'user' ||
    plan.ptyIds.length > 0 ||
    !plan.worktreeId ||
    getConnectionIdFromState(state, plan.worktreeId) !== null ||
    getExecutionHostIdForWorktree(state, plan.worktreeId) !== 'local'
  ) {
    return
  }
  if (
    Object.values(state.unifiedTabsByWorktree).some((tabs) =>
      tabs.some(
        (row) =>
          (row.id === tabId || row.entityId === tabId) &&
          (row.structuredSessionId || row.viewMode === 'chat')
      )
    )
  ) {
    return
  }
  const request = captureEmptyTerminalTabRetirement(state, plan.worktreeId, tabId)
  const retire = window.api.session?.retireEmptyTerminalTab
  if (!request || !retire) {
    return
  }
  void retire(request).catch((error: unknown) =>
    console.warn('Empty terminal tab retirement failed', error)
  )
}
