import { useAppStore } from '@/store'
import type { ContextualTourStep } from '../../../../shared/contextual-tours'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

export function performContextualTourPreStepAction(step: ContextualTourStep | undefined): boolean {
  const action = step?.preStepAction
  if (!action) {
    return true
  }
  switch (action.kind) {
    case 'show-folder-sidebar-tab':
      return routeFolderSidebarTab(action.tab)
  }
}

function routeFolderSidebarTab(tab: 'workspaces' | 'pr-checks'): boolean {
  const state = useAppStore.getState()
  const scope = parseWorkspaceKey(state.activeWorkspaceKey ?? state.activeWorktreeId ?? '')
  if (scope?.type !== 'folder') {
    return false
  }
  state.setRightSidebarOpen(true)
  state.setRightSidebarTab(tab)
  return true
}
