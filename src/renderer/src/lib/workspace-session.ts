import type {
  BrowserPage,
  BrowserWorkspace,
  PersistedOpenFile,
  WorkspaceSessionState,
  WorkspaceVisibleTabType
} from '../../../shared/types'
import { pruneLocalTerminalScrollbackBuffers } from '../../../shared/workspace-session-terminal-buffers'
import { normalizeBrowserHistoryEntries } from '../../../shared/workspace-session-browser-history'
import type { AppState } from '../store'
import type { OpenFile } from '../store/slices/editor'

/** Why (issue #1158): the debounced + shutdown session writers share this
 *  gate so a hydration failure cannot overwrite orca-data.json with the
 *  empty in-memory state the error path leaves behind.
 *
 *  - workspaceSessionReady gates the UI mount; it flips true even in the
 *    error path so users aren't locked out of a crashed session.
 *  - hydrationSucceeded only flips true after a clean load; it stays false
 *    forever if hydration ever threw, which is what keeps the writer a
 *    no-op for the rest of that process lifetime.
 *
 *  Both must be true to persist. */
export function shouldPersistWorkspaceSession(
  state: Pick<AppState, 'workspaceSessionReady' | 'hydrationSucceeded'>
): boolean {
  return state.workspaceSessionReady && state.hydrationSucceeded
}

export type WorkspaceSessionSnapshot = Pick<
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
  | 'lastVisitedAtByWorktreeId'
>

// Why: the App-level Zustand subscriber that debounces session writes uses
// this list as a shallow-equality gate so it only resets the timer when a
// field that actually feeds buildWorkspaceSessionPayload changes. Keeping
// the list co-located with WorkspaceSessionSnapshot means a future field
// added to the snapshot type fails the _exhaustive check below at compile
// time, preventing the gate from silently going stale.
export const SESSION_RELEVANT_FIELDS = [
  'activeRepoId',
  'activeWorktreeId',
  'activeTabId',
  'tabsByWorktree',
  'terminalLayoutsByTabId',
  'activeTabIdByWorktree',
  'openFiles',
  'activeFileIdByWorktree',
  'activeTabTypeByWorktree',
  'browserTabsByWorktree',
  'browserPagesByWorkspace',
  'activeBrowserTabIdByWorktree',
  'browserUrlHistory',
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'layoutByWorktree',
  'activeGroupIdByWorktree',
  'sshConnectionStates',
  'repos',
  'worktreesByRepo',
  'lastKnownRelayPtyIdByTabId',
  'lastVisitedAtByWorktreeId'
] as const satisfies readonly (keyof WorkspaceSessionSnapshot)[]

type _MissingSessionField = Exclude<
  keyof WorkspaceSessionSnapshot,
  (typeof SESSION_RELEVANT_FIELDS)[number]
>
const _exhaustive: [_MissingSessionField] extends [never] ? true : never = true
void _exhaustive

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
  const tabsByWorktree = snapshot.tabsByWorktree
  const activeTabIdByWorktree = snapshot.activeTabIdByWorktree
  const unifiedTabsByWorktree = snapshot.unifiedTabsByWorktree
  const groupsByWorktree = snapshot.groupsByWorktree
  const layoutByWorktree = snapshot.layoutByWorktree
  const activeGroupIdByWorktree = snapshot.activeGroupIdByWorktree

  // Why: lastKnownRelayPtyIdByTabId preserves session IDs across relay
  // disconnect/reconnect cycles. tab.ptyId is cleared on disconnect, but
  // the relay keeps the PTY alive — using the lastKnown fallback ensures
  // the session save captures the ID even when the mux is temporarily down.
  const lastKnown = snapshot.lastKnownRelayPtyIdByTabId

  const activeWorktreeIdsOnShutdown = Object.entries(tabsByWorktree)
    .filter(([, tabs]) => tabs.some((tab) => tab.ptyId || lastKnown[tab.id]))
    .map(([worktreeId]) => worktreeId)

  // Why: sshConnectionStates is a Map<string, SshConnectionState>, not a plain
  // object. Object.entries() on a Map returns [] — must use Array.from().
  const connectedTargetIds = Array.from(snapshot.sshConnectionStates.entries())
    .filter(([, state]) => state.status === 'connected')
    .map(([targetId]) => targetId)

  const worktreeById = new Map(
    Object.values(snapshot.worktreesByRepo)
      .flat()
      .map((worktree) => [worktree.id, worktree])
  )
  const repoById = new Map(snapshot.repos.map((repo) => [repo.id, repo]))

  // Why: the renderer already has tab.ptyId for every terminal tab and knows
  // which worktrees are SSH-backed via repo.connectionId. Deriving the map
  // here avoids a sync IPC round-trip during beforeunload, which is fragile
  // (can be dropped by Chromium under shutdown time pressure).
  // Why: this builder runs from the session-write debounce and beforeunload.
  // Pre-index repo/worktree identity once so large workspaces don't rescan all
  // repos/worktrees for every terminal tab while the renderer is trying to quit.
  const remoteSessionIdsByTabId: Record<string, string> = {}
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const worktree = worktreeById.get(worktreeId)
    const repo = worktree ? repoById.get(worktree.repoId) : null
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

  // Why: pendingActivationSpawn is documented on TerminalTab as a transient
  // renderer-only handoff between setActiveWorktree and the next updateTabPtyId
  // — it must never be persisted. The main-process session:set handler writes
  // the payload to disk without re-parsing it against the Zod schema, so if
  // the flag were ever set and not consumed before a save (e.g. app quits
  // mid-handoff), it would round-trip to disk and the next session would
  // start with a stale suppression flag that drops the first legitimate PTY
  // spawn from the sidebar's recency sort. Strip it here to enforce the
  // type-level invariant at the persistence boundary.
  const sanitizedTabsByWorktree = Object.fromEntries(
    Object.entries(tabsByWorktree).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.map((tab) => {
        const { pendingActivationSpawn: _unused, ...rest } = tab
        void _unused
        return rest
      })
    ])
  )

  const payload = {
    activeRepoId: snapshot.activeRepoId,
    activeWorktreeId: snapshot.activeWorktreeId,
    activeTabId: snapshot.activeTabId,
    tabsByWorktree: sanitizedTabsByWorktree,
    terminalLayoutsByTabId: snapshot.terminalLayoutsByTabId,
    // Why: session:set fully replaces the persisted object, so every write path
    // must carry forward which worktrees still had live PTYs. Dropping this
    // field silently disables eager terminal reconnect on the next restart.
    activeWorktreeIdsOnShutdown,
    activeTabIdByWorktree,
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
    // Why: browser history is user-lifetime state. Enforce the storage cap at
    // the payload boundary so stale renderer state cannot make every session
    // write stringify an oversized legacy history array.
    browserUrlHistory: normalizeBrowserHistoryEntries(snapshot.browserUrlHistory),
    unifiedTabs: unifiedTabsByWorktree,
    tabGroups: groupsByWorktree,
    tabGroupLayouts: layoutByWorktree,
    activeGroupIdByWorktree,
    activeConnectionIdsAtShutdown: connectedTargetIds.length > 0 ? connectedTargetIds : undefined,
    remoteSessionIdsByTabId:
      Object.keys(remoteSessionIdsByTabId).length > 0 ? remoteSessionIdsByTabId : undefined,
    // Why: per-worktree focus-recency for Cmd+J's empty-query ordering.
    // Omit when empty so sessions written by builds that never stamped
    // anything don't bloat the payload. See
    // docs/cmd-j-empty-query-ordering.md.
    lastVisitedAtByWorktreeId:
      snapshot.lastVisitedAtByWorktreeId &&
      Object.keys(snapshot.lastVisitedAtByWorktreeId).length > 0
        ? snapshot.lastVisitedAtByWorktreeId
        : undefined
  }

  return pruneLocalTerminalScrollbackBuffers(payload, snapshot.repos)
}
