import type { AppState } from '../types'
import {
  folderWorkspaceBrowserContentBelongsToRemovedOwner,
  folderWorkspaceEditorFileBelongsToRemovedOwner
} from './folder-workspace-content-removal-snapshot'
import type { FolderWorkspaceRendererOwnerRemoval } from './folder-workspace-renderer-teardown'

type FolderWorkspaceContentRemoval = {
  browserWorkspaceIds: readonly string[]
  editorFileIds: readonly string[]
  ownerRemoval: FolderWorkspaceRendererOwnerRemoval
  unifiedTabIds: readonly string[]
  workspaceKey: string
}

function pruneRecentlyClosedTabKinds(
  kinds: AppState['recentlyClosedTabKindsByWorktree'][string],
  removedBrowserSnapshots: readonly boolean[],
  removedEditorSnapshots: readonly boolean[]
): AppState['recentlyClosedTabKindsByWorktree'][string] {
  let browserIndex = 0
  let editorIndex = 0
  return kinds.filter((kind) => {
    if (kind === 'terminal') {
      // Why: terminal close snapshots lack host provenance, so a sibling cannot safely inherit them.
      return false
    }
    if (kind === 'browser') {
      return removedBrowserSnapshots[browserIndex++] !== true
    }
    if (kind === 'editor') {
      return removedEditorSnapshots[editorIndex++] !== true
    }
    return true
  })
}

function omitRecordKeys<T>(
  record: Record<string, T>,
  keys: ReadonlySet<string>
): Record<string, T> {
  if (![...keys].some((key) => key in record)) {
    return record
  }
  const next = { ...record }
  keys.forEach((key) => delete next[key])
  return next
}

export function pruneFolderWorkspaceContentState(
  state: AppState,
  removal: FolderWorkspaceContentRemoval
): Partial<AppState> {
  const browserWorkspaceIds = new Set(removal.browserWorkspaceIds)
  const editorFileIds = new Set(removal.editorFileIds)
  const unifiedTabIds = new Set(removal.unifiedTabIds)
  const pageIds = new Set(
    removal.browserWorkspaceIds.flatMap((workspaceId) =>
      (state.browserPagesByWorkspace[workspaceId] ?? []).map((page) => page.id)
    )
  )
  const removedOrderIds = new Set([...browserWorkspaceIds, ...editorFileIds, ...unifiedTabIds])
  const recentlyClosedBrowserTabs =
    state.recentlyClosedBrowserTabsByWorktree[removal.workspaceKey] ?? []
  const removedBrowserSnapshots = recentlyClosedBrowserTabs.map((snapshot) =>
    folderWorkspaceBrowserContentBelongsToRemovedOwner(
      snapshot.workspace.workspaceExecutionHostId,
      snapshot.pages,
      [],
      removal.ownerRemoval
    )
  )
  const recentlyClosedEditorTabs =
    state.recentlyClosedEditorTabsByWorktree[removal.workspaceKey] ?? []
  const removedEditorSnapshots = recentlyClosedEditorTabs.map((snapshot) =>
    folderWorkspaceEditorFileBelongsToRemovedOwner(snapshot, removal.ownerRemoval)
  )
  const remainingBrowserTabs = (state.browserTabsByWorktree[removal.workspaceKey] ?? []).filter(
    (tab) => !browserWorkspaceIds.has(tab.id)
  )
  const remainingFiles = state.openFiles.filter(
    (file) => file.worktreeId === removal.workspaceKey && !editorFileIds.has(file.id)
  )
  const nextBrowserTabId = remainingBrowserTabs[0]?.id ?? null
  const nextFileId = remainingFiles[0]?.id ?? null
  const activeBrowserRemoved =
    state.activeBrowserTabId !== null && browserWorkspaceIds.has(state.activeBrowserTabId)
  const activeFileRemoved = state.activeFileId !== null && editorFileIds.has(state.activeFileId)
  const activeTabTypeByWorktree = { ...state.activeTabTypeByWorktree }
  if (
    activeTabTypeByWorktree[removal.workspaceKey] === 'browser' &&
    remainingBrowserTabs.length === 0
  ) {
    activeTabTypeByWorktree[removal.workspaceKey] =
      remainingFiles.length > 0 ? 'editor' : 'terminal'
  } else if (
    activeTabTypeByWorktree[removal.workspaceKey] === 'editor' &&
    remainingFiles.length === 0
  ) {
    activeTabTypeByWorktree[removal.workspaceKey] =
      remainingBrowserTabs.length > 0 ? 'browser' : 'terminal'
  }
  const nextActiveTabType =
    state.activeWorktreeId === removal.workspaceKey
      ? (activeTabTypeByWorktree[removal.workspaceKey] ?? state.activeTabType)
      : state.activeTabType

  return {
    browserTabsByWorktree: {
      ...state.browserTabsByWorktree,
      [removal.workspaceKey]: remainingBrowserTabs
    },
    browserPagesByWorkspace: omitRecordKeys(state.browserPagesByWorkspace, browserWorkspaceIds),
    browserAnnotationsByPageId: omitRecordKeys(state.browserAnnotationsByPageId, pageIds),
    browserCertificateFailuresByPageId: omitRecordKeys(
      state.browserCertificateFailuresByPageId,
      pageIds
    ),
    remoteBrowserPageHandlesByPageId: omitRecordKeys(
      state.remoteBrowserPageHandlesByPageId,
      pageIds
    ),
    pendingAddressBarFocusByPageId: omitRecordKeys(state.pendingAddressBarFocusByPageId, pageIds),
    pendingAddressBarFocusByTabId: omitRecordKeys(
      omitRecordKeys(state.pendingAddressBarFocusByTabId, pageIds),
      browserWorkspaceIds
    ),
    recentlyClosedBrowserPagesByWorkspace: omitRecordKeys(
      state.recentlyClosedBrowserPagesByWorkspace,
      browserWorkspaceIds
    ),
    recentlyClosedBrowserTabsByWorktree: {
      ...state.recentlyClosedBrowserTabsByWorktree,
      [removal.workspaceKey]: recentlyClosedBrowserTabs.filter(
        (_, index) => removedBrowserSnapshots[index] !== true
      )
    },
    activeBrowserTabId: activeBrowserRemoved ? nextBrowserTabId : state.activeBrowserTabId,
    activeBrowserTabIdByWorktree: {
      ...state.activeBrowserTabIdByWorktree,
      [removal.workspaceKey]: browserWorkspaceIds.has(
        state.activeBrowserTabIdByWorktree[removal.workspaceKey] ?? ''
      )
        ? nextBrowserTabId
        : (state.activeBrowserTabIdByWorktree[removal.workspaceKey] ?? null)
    },
    openFiles: state.openFiles.filter((file) => !editorFileIds.has(file.id)),
    editorDrafts: omitRecordKeys(state.editorDrafts, editorFileIds),
    editorCursorLine: omitRecordKeys(state.editorCursorLine, editorFileIds),
    markdownViewMode: omitRecordKeys(state.markdownViewMode, editorFileIds),
    editorViewMode: omitRecordKeys(state.editorViewMode, editorFileIds),
    markdownFrontmatterVisible: omitRecordKeys(state.markdownFrontmatterVisible, editorFileIds),
    markdownTableOfContentsVisible: omitRecordKeys(
      state.markdownTableOfContentsVisible,
      editorFileIds
    ),
    activeFileId: activeFileRemoved ? nextFileId : state.activeFileId,
    activeFileIdByWorktree: {
      ...state.activeFileIdByWorktree,
      [removal.workspaceKey]: editorFileIds.has(
        state.activeFileIdByWorktree[removal.workspaceKey] ?? ''
      )
        ? nextFileId
        : (state.activeFileIdByWorktree[removal.workspaceKey] ?? null)
    },
    pendingEditorReveal:
      state.pendingEditorReveal?.fileId && editorFileIds.has(state.pendingEditorReveal.fileId)
        ? null
        : state.pendingEditorReveal,
    pendingEditorFocusRequest:
      state.pendingEditorFocusRequest && editorFileIds.has(state.pendingEditorFocusRequest.fileId)
        ? null
        : state.pendingEditorFocusRequest,
    recentlyClosedEditorTabsByWorktree: {
      ...state.recentlyClosedEditorTabsByWorktree,
      [removal.workspaceKey]: recentlyClosedEditorTabs.filter(
        (_, index) => removedEditorSnapshots[index] !== true
      )
    },
    recentlyClosedTerminalTabsByWorktree: {
      ...state.recentlyClosedTerminalTabsByWorktree,
      [removal.workspaceKey]: []
    },
    recentlyClosedTabKindsByWorktree: {
      ...state.recentlyClosedTabKindsByWorktree,
      [removal.workspaceKey]: pruneRecentlyClosedTabKinds(
        state.recentlyClosedTabKindsByWorktree[removal.workspaceKey] ?? [],
        removedBrowserSnapshots,
        removedEditorSnapshots
      )
    },
    tabBarOrderByWorktree: {
      ...state.tabBarOrderByWorktree,
      [removal.workspaceKey]: (state.tabBarOrderByWorktree[removal.workspaceKey] ?? []).filter(
        (id) => !removedOrderIds.has(id)
      )
    },
    activeTabTypeByWorktree,
    activeTabType: nextActiveTabType
  }
}
