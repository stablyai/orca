import type {
  BrowserPage,
  BrowserWorkspace,
  PersistedOpenFile,
  WorkspaceSessionState,
  WorkspaceVisibleTabType
} from '../../../shared/types'
import type { AppState } from '../store'
import type { OpenFile } from '../store/slices/editor'

type WorkspaceSessionSnapshot = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorktreeId'
  | 'activeTabId'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'activeTabIdByWorktree'
  | 'openFiles'
  | 'activeFileIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'browserTabsByWorktree'
  | 'browserPagesByWorkspace'
  | 'activeBrowserTabIdByWorktree'
  | 'browserUrlHistory'
  | 'unifiedTabsByWorktree'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'activeGroupIdByWorktree'
  | 'sshConnectionStates'
  | 'repos'
  | 'worktreesByRepo'
  | 'lastKnownRelayPtyIdByTabId'
>

/** Build the editor-file portion of the workspace session for persistence.
 *  Only edit-mode files are saved — diffs and conflict views are transient. */
export function buildEditorSessionData(
  openFiles: OpenFile[],
  activeFileIdByWorktree: Record<string, string | null>,
  activeTabTypeByWorktree: Record<string, WorkspaceVisibleTabType>
): Pick<
  WorkspaceSessionState,
  'openFilesByWorktree' | 'activeFileIdByWorktree' | 'activeTabTypeByWorktree'
> {
  const editFiles = openFiles.filter((f) => f.mode === 'edit')
  const byWorktree: Record<string, PersistedOpenFile[]> = {}
  const editFileIdsByWorktree: Record<string, Set<string>> = {}
  for (const f of editFiles) {
    const arr = byWorktree[f.worktreeId] ?? (byWorktree[f.worktreeId] = [])
    arr.push({
      filePath: f.filePath,
      relativePath: f.relativePath,
      worktreeId: f.worktreeId,
      language: f.language,
      isPreview: f.isPreview || undefined
    })
    const ids =
      editFileIdsByWorktree[f.worktreeId] ?? (editFileIdsByWorktree[f.worktreeId] = new Set())
    ids.add(f.id)
  }

  const activeFileEntries: [string, string][] = []
  for (const [worktreeId, fileId] of Object.entries(activeFileIdByWorktree)) {
    if (!fileId) {
      continue
    }
    if (editFileIdsByWorktree[worktreeId]?.has(fileId)) {
      activeFileEntries.push([worktreeId, fileId])
    }
  }
  const persistedActiveFileIdByWorktree = Object.fromEntries(activeFileEntries) as Record<
    string,
    string
  >

  const activeTabTypeEntries: [string, WorkspaceVisibleTabType][] = []
  for (const [worktreeId, tabType] of Object.entries(activeTabTypeByWorktree)) {
    if (tabType !== 'editor') {
      activeTabTypeEntries.push([worktreeId, tabType])
      continue
    }
    // Why: restart only restores edit-mode files. Persisting "editor" with a
    // transient diff/conflict file ID creates a session payload that cannot be
    // satisfied on startup and leaves the UI with no real editor tab to select.
    // Only keep the editor marker when it points at a restored file.
    if (persistedActiveFileIdByWorktree[worktreeId]) {
      activeTabTypeEntries.push([worktreeId, tabType])
    }
  }
  const persistedActiveTabTypeByWorktree = Object.fromEntries(activeTabTypeEntries) as Record<
    string,
    WorkspaceVisibleTabType
  >

  return {
    openFilesByWorktree: byWorktree,
    activeFileIdByWorktree: persistedActiveFileIdByWorktree,
    activeTabTypeByWorktree: persistedActiveTabTypeByWorktree
  }
}

export function buildBrowserSessionData(
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>,
  browserPagesByWorkspace: Record<string, BrowserPage[]>,
  activeBrowserTabIdByWorktree: Record<string, string | null>
): Pick<
  WorkspaceSessionState,
  'browserTabsByWorktree' | 'browserPagesByWorkspace' | 'activeBrowserTabIdByWorktree'
> {
  return {
    // Why: browser tabs persist only lightweight chrome state. Live guest
    // webContents are recreated on restore, so loading is reset to false and
    // transient errors are preserved only as last-known tab metadata.
    browserTabsByWorktree: Object.fromEntries(
      Object.entries(browserTabsByWorktree).map(([worktreeId, tabs]) => [
        worktreeId,
        tabs.map((tab) => ({ ...tab, loading: false }))
      ])
    ),
    browserPagesByWorkspace: Object.fromEntries(
      Object.entries(browserPagesByWorkspace).map(([workspaceId, pages]) => [
        workspaceId,
        pages.map((page) => ({ ...page, loading: false }))
      ])
    ),
    activeBrowserTabIdByWorktree
  }
}

export function buildWorkspaceSessionPayload(
  snapshot: WorkspaceSessionSnapshot
): WorkspaceSessionState {
  // Why: lastKnownRelayPtyIdByTabId preserves session IDs across relay
  // disconnect/reconnect cycles. tab.ptyId is cleared on disconnect, but
  // the relay keeps the PTY alive — using the lastKnown fallback ensures
  // the session save captures the ID even when the mux is temporarily down.
  const lastKnown = snapshot.lastKnownRelayPtyIdByTabId

  const activeWorktreeIdsOnShutdown = Object.entries(snapshot.tabsByWorktree)
    .filter(([, tabs]) => tabs.some((tab) => tab.ptyId || lastKnown[tab.id]))
    .map(([worktreeId]) => worktreeId)

  // Why: sshConnectionStates is a Map<string, SshConnectionState>, not a plain
  // object. Object.entries() on a Map returns [] — must use Array.from().
  const connectedTargetIds = Array.from(snapshot.sshConnectionStates.entries())
    .filter(([, state]) => state.status === 'connected')
    .map(([targetId]) => targetId)

  // Why: the renderer already has tab.ptyId for every terminal tab and knows
  // which worktrees are SSH-backed via repo.connectionId. Deriving the map
  // here avoids a sync IPC round-trip during beforeunload, which is fragile
  // (can be dropped by Chromium under shutdown time pressure).
  const remoteSessionIdsByTabId: Record<string, string> = {}
  for (const [worktreeId, tabs] of Object.entries(snapshot.tabsByWorktree)) {
    const worktree = Object.values(snapshot.worktreesByRepo)
      .flat()
      .find((w) => w.id === worktreeId)
    const repo = worktree ? snapshot.repos.find((r) => r.id === worktree.repoId) : null
    if (!repo?.connectionId) {
      continue
    }
    for (const tab of tabs) {
      const sessionId = tab.ptyId || lastKnown[tab.id]
      if (sessionId) {
        remoteSessionIdsByTabId[tab.id] = sessionId
      }
    }
  }

  return {
    activeRepoId: snapshot.activeRepoId,
    activeWorktreeId: snapshot.activeWorktreeId,
    activeTabId: snapshot.activeTabId,
    tabsByWorktree: snapshot.tabsByWorktree,
    terminalLayoutsByTabId: snapshot.terminalLayoutsByTabId,
    // Why: session:set fully replaces the persisted object, so every write path
    // must carry forward which worktrees still had live PTYs. Dropping this
    // field silently disables eager terminal reconnect on the next restart.
    activeWorktreeIdsOnShutdown,
    activeTabIdByWorktree: snapshot.activeTabIdByWorktree,
    ...buildEditorSessionData(
      snapshot.openFiles,
      snapshot.activeFileIdByWorktree,
      snapshot.activeTabTypeByWorktree
    ),
    ...buildBrowserSessionData(
      snapshot.browserTabsByWorktree,
      snapshot.browserPagesByWorkspace,
      snapshot.activeBrowserTabIdByWorktree
    ),
    browserUrlHistory: snapshot.browserUrlHistory,
    unifiedTabs: snapshot.unifiedTabsByWorktree,
    tabGroups: snapshot.groupsByWorktree,
    tabGroupLayouts: snapshot.layoutByWorktree,
    activeGroupIdByWorktree: snapshot.activeGroupIdByWorktree,
    activeConnectionIdsAtShutdown: connectedTargetIds.length > 0 ? connectedTargetIds : undefined,
    remoteSessionIdsByTabId:
      Object.keys(remoteSessionIdsByTabId).length > 0 ? remoteSessionIdsByTabId : undefined
  }
}
