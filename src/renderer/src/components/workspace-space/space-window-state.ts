import type { AppState } from '@/store/types'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

export function pickSpaceWindowState(state: AppState) {
  return {
    workspaceSpaceAnalysis: state.workspaceSpaceAnalysis,
    workspaceSpaceScanError: state.workspaceSpaceScanError,
    workspaceSpaceScanProgress: state.workspaceSpaceScanProgress,
    workspaceSpaceScanning: state.workspaceSpaceScanning,
    workspaceSpaceMeasurements: state.workspaceSpaceMeasurements,
    repos: state.repos,
    worktreesByRepo: selectWorktreesByRepo(state),
    detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state),
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
    removedRuntimeEnvironmentIds: state.removedRuntimeEnvironmentIds,
    folderWorkspaces: selectFolderWorkspaces(state),
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
    settings: state.settings,
    tabsByWorktree: state.tabsByWorktree,
    ptyIdsByTabId: state.ptyIdsByTabId,
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId,
    runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId,
    agentStatusEpoch: state.agentStatusEpoch,
    retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
    openFiles: state.openFiles,
    editorDrafts: state.editorDrafts,
    browserTabsByWorktree: state.browserTabsByWorktree,
    gitStatusByWorktree: state.gitStatusByWorktree,
    remoteStatusesByWorktree: state.remoteStatusesByWorktree,
    hostedReviewCache: state.hostedReviewCache,
    issueCache: state.issueCache,
    linearIssueCache: state.linearIssueCache,
    activeWorktreeId: state.activeWorktreeId,
    activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
    deleteStateByWorktreeId: state.deleteStateByWorktreeId,
    worktreeLineageById: state.worktreeLineageById,
    sshConnectionStates: state.sshConnectionStates,
    sshTargetLabels: state.sshTargetLabels
  }
}

export type SpaceWindowState = ReturnType<typeof pickSpaceWindowState>

export function selectSpaceWindowAnalysis(
  current: SpaceWindowState['workspaceSpaceAnalysis'],
  incoming: SpaceWindowState['workspaceSpaceAnalysis']
): SpaceWindowState['workspaceSpaceAnalysis'] {
  if (!current || !incoming) {
    return current ?? incoming
  }
  if (current.scannedAt !== incoming.scannedAt) {
    return current.scannedAt > incoming.scannedAt ? current : incoming
  }
  if (current.worktrees.length !== incoming.worktrees.length) {
    return current.worktrees.length < incoming.worktrees.length ? current : incoming
  }
  const detailCount = (analysis: typeof current): number =>
    analysis.worktrees.reduce((total, row) => total + row.topLevelItems.length, 0)
  return detailCount(incoming) > detailCount(current) ? incoming : current
}

export function isSpaceWindowState(value: unknown): value is SpaceWindowState {
  return (
    value !== null &&
    typeof value === 'object' &&
    'repos' in value &&
    Array.isArray(value.repos) &&
    'worktreesByRepo' in value &&
    typeof value.worktreesByRepo === 'object' &&
    'workspaceSpaceAnalysis' in value &&
    'settings' in value
  )
}

export function spaceWindowStateChanged(a: AppState, b: AppState): boolean {
  const before = Object.values(pickSpaceWindowState(a))
  const after = Object.values(pickSpaceWindowState(b))
  return before.some((value, index) => value !== after[index])
}
