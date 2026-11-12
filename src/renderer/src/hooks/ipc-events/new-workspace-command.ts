import type { WorkspaceSource } from '../../../../shared/workspace-source'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { buildLinearWorkspaceSource } from '../../../../shared/new-workspace/workspace-source'
import type { LinkedWorkItemSummary } from '@/lib/workspace/creation/new-workspace'
import { getLinearIssueWorkspaceName } from '../../../../shared/workspace-name'
import type { AppState } from '../../store/types'

type NewWorkspaceShortcutModalData = {
  telemetrySource: 'shortcut'
  prefilledName?: string
  linkedWorkItem?: LinkedWorkItemSummary
}

export function buildNewWorkspaceShortcutModalData(
  state: Pick<AppState, 'activeView' | 'taskPageData'>
): NewWorkspaceShortcutModalData {
  const linearIssue =
    state.activeView === 'tasks' ? (state.taskPageData.openLinearIssue ?? null) : null
  if (!linearIssue) {
    return { telemetrySource: 'shortcut' }
  }

  return {
    telemetrySource: 'shortcut',
    prefilledName: getLinearIssueWorkspaceName(linearIssue),
    // Cmd+N from a Linear issue mirrors its Start-workspace action with source context.
    linkedWorkItem: buildLinearWorkspaceSource(linearIssue)
  }
}

export function openNewWorkspaceFromShortcut(
  state: Pick<AppState, 'activeModal' | 'activeView' | 'taskPageData' | 'openModal'>
): void {
  if (state.activeModal === 'new-workspace-composer') {
    return
  }
  state.openModal('new-workspace-composer', buildNewWorkspaceShortcutModalData(state))
}

/** New cloud workspace (⇧⌘N, File menu, palette, sidebar, Landing, Cloud home): the composer on Orca Cloud. */
export function openNewCloudWorkspace(
  state: Pick<AppState, 'activeModal' | 'openModal'>,
  telemetrySource: WorkspaceSource = 'shortcut'
): void {
  if (state.activeModal === 'new-workspace-composer') {
    return
  }
  state.openModal('new-workspace-composer', {
    telemetrySource,
    initialEphemeralVmRecipeId: ORCA_CLOUD_RECIPE_ID
  })
}
