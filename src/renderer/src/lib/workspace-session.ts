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
  | 'unifiedTabsByWorktree'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'activeGroupIdByWorktree'
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

  const persistedActiveFileIdByWorktree = Object.fromEntries(
    Object.entries(activeFileIdByWorktree).flatMap(([worktreeId, fileId]) => {
      if (!fileId) {
        return []
      }
      return editFileIdsByWorktree[worktreeId]?.has(fileId) ? [[worktreeId, fileId]] : []
    })
  )

  const persistedActiveTabTypeByWorktree = Object.fromEntries(
    Object.entries(activeTabTypeByWorktree).flatMap(([worktreeId, tabType]) => {
      if (tabType !== 'editor') {
        return [[worktreeId, tabType]]
      }
      // Why: restart only restores edit-mode files. Persisting "editor" with a
      // transient diff/conflict file ID creates a session payload that cannot
      // be satisfied on startup and leaves the UI with no real editor tab to
      // select. Only keep the editor marker when it points at a restored file.
      return persistedActiveFileIdByWorktree[worktreeId] ? [[worktreeId, tabType]] : []
    })
  )

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
  const activeWorktreeIdsOnShutdown = Object.entries(snapshot.tabsByWorktree)
    .filter(([, tabs]) => tabs.some((tab) => tab.ptyId))
    .map(([worktreeId]) => worktreeId)

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
    unifiedTabs: snapshot.unifiedTabsByWorktree,
    tabGroups: snapshot.groupsByWorktree,
    tabGroupLayouts: snapshot.layoutByWorktree,
    activeGroupIdByWorktree: snapshot.activeGroupIdByWorktree
  }
}
