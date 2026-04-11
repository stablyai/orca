import type {
  BrowserTab,
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
  | 'activeBrowserTabIdByWorktree'
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
  for (const f of editFiles) {
    const arr = byWorktree[f.worktreeId] ?? (byWorktree[f.worktreeId] = [])
    arr.push({
      filePath: f.filePath,
      relativePath: f.relativePath,
      worktreeId: f.worktreeId,
      language: f.language,
      isPreview: f.isPreview || undefined
    })
  }
  return {
    openFilesByWorktree: byWorktree,
    activeFileIdByWorktree,
    activeTabTypeByWorktree
  }
}

export function buildBrowserSessionData(
  browserTabsByWorktree: Record<string, BrowserTab[]>,
  activeBrowserTabIdByWorktree: Record<string, string | null>
): Pick<WorkspaceSessionState, 'browserTabsByWorktree' | 'activeBrowserTabIdByWorktree'> {
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
      snapshot.activeBrowserTabIdByWorktree
    )
  }
}
