import type { Tab } from '../../../shared/tab-types'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { resolveUnifiedTabLabel } from '../../../shared/tab-title-resolution'
import { selectWorkspaceByHostTarget } from '@/store/workspace-record-selectors'
import type { AppState } from '@/store/types'
import { findIndexedRepoOwnerForHost } from './worktree-runtime-owner-index'
import { getResolvedExecutionHostIdForWorktree } from './resolved-worktree-execution-host'
import { resolveWorktreeDisplayName } from './worktree-default-display-name'
import {
  isOpenFileOwnedByWorktree,
  hasOpenFileExecutionHostEvidence,
  isUnifiedTabOwnedByWorktree,
  findAmbiguousWorktreeIds,
  getPaletteOwnershipWorktreeIds
} from './unified-tab-host-ownership'
import type { WorkspaceViewPanel, WorkspaceView } from './workspace-view-layout'

export type WorkspaceViewCatalogState = Pick<
  AppState,
  | 'unifiedTabsByWorktree'
  | 'groupsByWorktree'
  | 'worktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'repos'
  | 'openFiles'
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'settings'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
>

export function selectShownWorkspaceView(
  state: Pick<
    AppState,
    'workspaceViews' | 'activeWorkspaceViewId' | 'activeView' | 'activeWorktreeId'
  >
): WorkspaceView | null {
  if (state.activeView !== 'terminal') {
    return null
  }
  const view = state.workspaceViews?.find((view) => view.id === state.activeWorkspaceViewId)
  return view &&
    (state.activeWorktreeId === null ||
      !view.panels.length ||
      view.panels.some((panel) => panel.workspaceId === state.activeWorktreeId))
    ? view
    : null
}

export function resolveWorkspaceViewTab(
  state: WorkspaceViewCatalogState,
  panel: Pick<WorkspaceViewPanel, 'workspaceId' | 'executionHostId' | 'tabId'>
): Tab | null {
  const workspace = selectWorkspaceByHostTarget(
    state,
    hostWorktreeTarget({
      id: panel.workspaceId,
      hostId: panel.executionHostId
    })
  )
  if (
    !workspace ||
    getResolvedExecutionHostIdForWorktree(state, panel.workspaceId) !== panel.executionHostId
  ) {
    return null
  }
  const tabs = state.unifiedTabsByWorktree[panel.workspaceId] ?? []
  const matches = tabs.filter((tab) => tab.id === panel.tabId)
  const tab = matches[0]
  if (
    matches.length !== 1 ||
    !tab ||
    tab.worktreeId !== panel.workspaceId ||
    !state.groupsByWorktree[panel.workspaceId]?.some((group) => group.id === tab.groupId)
  ) {
    return null
  }
  const ambiguous = findAmbiguousWorktreeIds(getPaletteOwnershipWorktreeIds(state))
  if (!isUnifiedTabOwnedByWorktree(tab, workspace, ambiguous)) {
    return null
  }
  if (['editor', 'diff', 'conflict-review', 'check-details'].includes(tab.contentType)) {
    const files = state.openFiles.filter(
      (file) => file.id === tab.entityId && file.worktreeId === panel.workspaceId
    )
    if (
      files.length !== 1 ||
      ((ambiguous.has(panel.workspaceId) || hasOpenFileExecutionHostEvidence(files[0])) &&
        !isOpenFileOwnedByWorktree(files[0], workspace))
    ) {
      return null
    }
  }
  return tab
}

export function collectWorkspaceViewPanels(
  state: WorkspaceViewCatalogState
): Omit<WorkspaceViewPanel, 'id'>[] {
  const panels: Omit<WorkspaceViewPanel, 'id'>[] = []
  for (const [workspaceId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    const executionHostId = getResolvedExecutionHostIdForWorktree(state, workspaceId)
    if (!executionHostId) {
      continue
    }
    const workspace = selectWorkspaceByHostTarget(
      state,
      hostWorktreeTarget({
        id: workspaceId,
        hostId: executionHostId
      })
    )
    if (!workspace) {
      continue
    }
    const repo = findIndexedRepoOwnerForHost(state.repos, workspace.repoId, executionHostId)
    for (const tab of tabs) {
      const target = { workspaceId, executionHostId, tabId: tab.id }
      if (!resolveWorkspaceViewTab(state, target)) {
        continue
      }
      panels.push({
        ...target,
        title: resolveUnifiedTabLabel(
          tab,
          state.settings?.tabAutoGenerateTitle === true,
          tab.label
        ),
        workspaceName: resolveWorktreeDisplayName(workspace) || workspace.path,
        projectName: repo?.displayName || resolveWorktreeDisplayName(workspace) || workspace.path
      })
    }
  }
  return panels
}
