import { buildLinearWorkspaceSource } from '../../../../shared/new-workspace/workspace-source'
import type { LinkedWorkItemSummary } from '@/lib/workspace/creation/new-workspace'
import { getLinearIssueWorkspaceName } from '../../../../shared/workspace/naming/workspace-name'
import type { AppState } from '../../store/types'

type NewWorkspaceShortcutModalData = {
  telemetrySource: 'shortcut'
  prefilledName?: string
  linkedWorkItem?: LinkedWorkItemSummary
  autoCreate?: boolean
}

export function buildNewWorkspaceShortcutModalData(
  state: Pick<AppState, 'activeView' | 'taskPageData' | 'settings'>
): NewWorkspaceShortcutModalData {
  const linearIssue =
    state.activeView === 'tasks' ? (state.taskPageData.openLinearIssue ?? null) : null
  if (!linearIssue) {
    return state.settings?.skipNewWorkspaceDialog
      ? { telemetrySource: 'shortcut', autoCreate: true }
      : { telemetrySource: 'shortcut' }
  }

  return {
    telemetrySource: 'shortcut',
    prefilledName: getLinearIssueWorkspaceName(linearIssue),
    // Cmd+N from a Linear issue mirrors its Start-workspace action with source context.
    linkedWorkItem: buildLinearWorkspaceSource(linearIssue)
  }
}

export function openNewWorkspaceFromShortcut(
  state: Pick<AppState, 'activeModal' | 'activeView' | 'taskPageData' | 'settings' | 'openModal'>
): void {
  if (state.activeModal === 'new-workspace-composer') {
    return
  }
  state.openModal('new-workspace-composer', buildNewWorkspaceShortcutModalData(state))
}
