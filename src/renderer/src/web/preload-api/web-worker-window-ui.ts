import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import { omitPairingLocalUiFields } from '../../../../shared/pairing-local-ui-fields'

const WORKER_WINDOW_UI_FIELDS = [
  'lastActiveRepoId',
  'lastActiveWorktreeId',
  'activeView',
  'sidebarWidth',
  'rightSidebarOpen',
  'rightSidebarTab',
  'rightSidebarExplorerView',
  'rightSidebarWidth',
  'uiZoomLevel',
  'editorFontZoomLevel',
  'workspaceHostScope',
  'visibleWorkspaceHostIds',
  'filterRepoIds',
  'groupBy',
  'sortBy',
  'projectOrderBy',
  'collapsedGroups',
  'hideSleepingWorkspaces',
  'hideDefaultBranchWorkspace',
  'hideAutomationGeneratedWorkspaces',
  'hideCliCreatedWorkspaces',
  'hideDetachedHeadWorkspaces'
] as const

export function isWorkerWindow(): boolean {
  return new URLSearchParams(window.location.search).get('orcaWindow') === 'worker'
}

export function omitWorkerWindowUiFields(
  updates: Partial<PersistedUIState>
): Partial<PersistedUIState> {
  const hostUpdates = omitPairingLocalUiFields(updates)
  if (!isWorkerWindow()) {
    return hostUpdates
  }
  for (const field of WORKER_WINDOW_UI_FIELDS) {
    delete hostUpdates[field]
  }
  return hostUpdates
}

export function workerWindowLocalUiState(local: PersistedUIState): Partial<PersistedUIState> {
  return isWorkerWindow()
    ? Object.fromEntries(WORKER_WINDOW_UI_FIELDS.map((field) => [field, local[field]]))
    : {}
}
