import { useAppStore } from '@/store'
import { getActiveExecutionHostIdForWorktree } from '@/lib/unified-tab-host-ownership'
import { translate } from '@/i18n/i18n'

export function createAgentCanvasTab(worktreeId: string, groupId: string): void {
  const state = useAppStore.getState()
  const executionHostId = getActiveExecutionHostIdForWorktree(state, worktreeId)
  if (!executionHostId) {
    return
  }
  const tab = state.createUnifiedTab(worktreeId, 'canvas', {
    label: translate('agentCanvas.canvas', 'Canvas'),
    executionHostId,
    targetGroupId: groupId,
    activate: true
  })
  state.activateTab(tab.id)
  state.focusGroup(worktreeId, tab.groupId)
  state.setActiveTabType('canvas')
  state.setAgentDashboardDrawerOpen(false)
}
