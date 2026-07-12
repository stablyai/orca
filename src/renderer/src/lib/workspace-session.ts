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
import { buildPersistedUnifiedTabSessionData } from './workspace-session-unified-tabs'
import { buildLastVisitedAtByWorktreeId } from './workspace-session-focus-recency'
import { buildSleepingAgentSessionData } from './workspace-session-sleeping-agents'

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
  | 'activeWorkspaceKey'
  | 'activeWorktreeId'
  | 'activeTabId'
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
  | 'activeTabIdByWorktree'
  | 'openFiles'
  | 'editorDrafts'
  | 'markdownFrontmatterVisible'
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
  | 'defaultTerminalTabsAppliedByWorktreeId'
> & {
  sleepingAgentSessionsByPaneKey?: AppState['sleepingAgentSessionsByPaneKey']
}

// Why: the App-level Zustand subscriber that debounces session writes uses
// this list as a shallow-equality gate so it only resets the timer when a
// field that actually feeds buildWorkspaceSessionPayload changes. Keeping
// the list co-located with WorkspaceSessionSnapshot means a future field
// added to the snapshot type fails the _exhaustive check below at compile
// time, preventing the gate from silently going stale.
export const SESSION_RELEVANT_FIELDS = [
  'activeRepoId',
  'activeWorkspaceKey',
  'activeWorktreeId',
  'activeTabId',
  'tabsByWorktree',
  'ptyIdsByTabId',
  'terminalLayoutsByTabId',
  'activeTabIdByWorktree',
  'openFiles',
  'editorDrafts',
  'markdownFrontmatterVisible',
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
  'lastVisitedAtByWorktreeId',
  'defaultTerminalTabsAppliedByWorktreeId',
  'sleepingAgentSessionsByPaneKey'
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
  editorDrafts: Record<string, string>,
  markdownFrontmatterVisible: Record<string, boolean>,
  activeFileIdByWorktree: Record<string, string | null>,
  activeTabTypeByWorktree: Record<string, WorkspaceVisibleTabType>
): Pick<
  WorkspaceSessionState,
  | 'openFilesByWorktree'
  | 'activeFileIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'markdownFrontmatterVisible'
> {
  const editFiles = openFiles.filter((f) => f.mode === 'edit')
  const byWorktree: Record<string, PersistedOpenFile[]> = {}
  const editFileIdsByWorktree: Record<string, Set<string>> = {}
  for (const f of editFiles) {
    const arr = byWorktree[f.worktreeId] ?? (byWorktree[f.worktreeId] = [])
    // Why: read-only tabs never persist a dirty draft even if isDirty is
    // somehow set — restoring a draft would reintroduce writable/hot-exit state
    // for an agent-owned transcript.
    const dirtyDraftContent = f.isDirty && f.readOnly !== true ? editorDrafts[f.id] : undefined
    arr.push({
      filePath: f.filePath,
      relativePath: f.relativePath,
      worktreeId: f.worktreeId,
      language: f.language,
      isPreview: f.isPreview || undefined,
      runtimeEnvironmentId: f.runtimeEnvironmentId,
      // Why: persist read-only only when true so pre-existing writable sessions
      // stay writable on restore (absence is the writable default).
      ...(f.readOnly === true ? { readOnly: true } : {}),
      ...(f.readOnly === true && f.liveTail === true ? { liveTail: true } : {}),
      ...(dirtyDraftContent !== undefined ? { dirtyDraftContent } : {}),
      // Why: the edit baseline travels with the dirty draft so a restore can
      // re-derive a changed-on-disk conflict before autosave may overwrite an
      // agent write that landed while the app was closed.
      ...(dirtyDraftContent !== undefined && f.lastKnownDiskSignature
        ? { lastKnownDiskSignature: f.lastKnownDiskSignature }
        : {})
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
  const allEditFileIds = new Set(Object.values(editFileIdsByWorktree).flatMap((ids) => [...ids]))
  const persistedMarkdownFrontmatterVisible = Object.fromEntries(
    Object.keys(markdownFrontmatterVisible ?? {})
      .filter((fileId) => allEditFileIds.has(fileId))
      .map((fileId) => [fileId, true])
  )

  return {
    openFilesByWorktree: byWorktree,
    activeFileIdByWorktree: persistedActiveFileIdByWorktree,
    activeTabTypeByWorktree: persistedActiveTabTypeByWorktree,
    markdownFrontmatterVisible: persistedMarkdownFrontmatterVisible
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
    browserTabsByWorktree: buildPersistedBrowserTabsByWorktree(browserTabsByWorktree),
    browserPagesByWorkspace: buildPersistedBrowserPagesByWorkspace(browserPagesByWorkspace),
    activeBrowserTabIdByWorktree
  }
}

export function buildPersistedBrowserTabsByWorktree(
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>
): WorkspaceSessionState['browserTabsByWorktree'] {
  return Object.fromEntries(
    Object.entries(browserTabsByWorktree).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.map((tab) => ({ ...tab, loading: false }))
    ])
  )
}

export function buildPersistedBrowserPagesByWorkspace(
  browserPagesByWorkspace: Record<string, BrowserPage[]>
): WorkspaceSessionState['browserPagesByWorkspace'] {
  return Object.fromEntries(
    Object.entries(browserPagesByWorkspace).map(([workspaceId, pages]) => [
      workspaceId,
      pages.map((page) => ({ ...page, loading: false }))
    ])
  )
}

export function buildSanitizedTabsByWorktree(
  tabsByWorktree: WorkspaceSessionSnapshot['tabsByWorktree']
): WorkspaceSessionState['tabsByWorktree'] {
  // Why: pendingActivationSpawn is documented on TerminalTab as a transient
  // renderer-only handoff between setActiveWorktree and the next updateTabPtyId
  // — it must never be persisted. The main-process session:set handler writes
  // the payload to disk without re-parsing it against the Zod schema, so if
  // the flag were ever set and not consumed before a save (e.g. app quits
  // mid-handoff), it would round-trip to disk and the next session would
  // start with a stale suppression flag that drops the first legitimate PTY
  // spawn from the sidebar's recency sort. Strip it here to enforce the
  // type-level invariant at the persistence boundary.
  return Object.fromEntries(
    Object.entries(tabsByWorktree).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.map((tab) => {
        const { pendingActivationSpawn: _unused, ...rest } = tab
        void _unused
        return rest
      })
    ])
  )
}

export function buildTerminalSessionData(
  snapshot: WorkspaceSessionSnapshot
): Pick<WorkspaceSessionState, 'activeWorktreeIdsOnShutdown' | 'remoteSessionIdsByTabId'> {
  const tabsByWorktree = snapshot.tabsByWorktree

  // Why: ptyIdsByTabId is the live-PTY map. tab.ptyId is only a wake hint that
  // sleep intentionally preserves, so using it as liveness would revive slept
  // worktrees as active after restart.
  const ptyIdsByTabId = snapshot.ptyIdsByTabId
  const hasLivePty = (tabId: string): boolean => (ptyIdsByTabId[tabId]?.length ?? 0) > 0

  // Why: lastKnownRelayPtyIdByTabId preserves remote session IDs across relay
  // disconnect/reconnect cycles, where clearTabPtyId(null) clears tab.ptyId
  // but keeps the relay PTY alive. Sleep is different: it preserves tab.ptyId
  // as a wake hint after clearing ptyIdsByTabId, so that shape must not count
  // as active on restart.
  const lastKnown = snapshot.lastKnownRelayPtyIdByTabId
  const hasReconnectableSession = (tab: { id: string; ptyId: string | null }): boolean =>
    hasLivePty(tab.id) || (!tab.ptyId && Boolean(lastKnown[tab.id]))

  const activeWorktreeIdsOnShutdown = Object.entries(tabsByWorktree)
    .filter(([, tabs]) => tabs.some(hasReconnectableSession))
    .map(([worktreeId]) => worktreeId)

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
      if (!hasReconnectableSession(tab)) {
        continue
      }
      const sessionId = tab.ptyId || lastKnown[tab.id]
      if (sessionId) {
        remoteSessionIdsByTabId[tab.id] = sessionId
      }
    }
  }

  return {
    activeWorktreeIdsOnShutdown,
    remoteSessionIdsByTabId:
      Object.keys(remoteSessionIdsByTabId).length > 0 ? remoteSessionIdsByTabId : undefined
  }
}

export function buildActiveConnectionIdsAtShutdown(
  snapshot: WorkspaceSessionSnapshot
): WorkspaceSessionState['activeConnectionIdsAtShutdown'] {
  // Why: sshConnectionStates is a Map<string, SshConnectionState>, not a plain
  // object. Object.entries() on a Map returns [] — must use Array.from().
  const connectedTargetIds = Array.from(snapshot.sshConnectionStates.entries())
    .filter(([, state]) => state.status === 'connected')
    .map(([targetId]) => targetId)

  return connectedTargetIds.length > 0 ? connectedTargetIds : undefined
}

export function buildWorkspaceSessionPayload(
  snapshot: WorkspaceSessionSnapshot
): WorkspaceSessionState {
  const terminalSessionData = buildTerminalSessionData(snapshot)

  const payload = {
    activeRepoId: snapshot.activeRepoId,
    activeWorkspaceKey: snapshot.activeWorkspaceKey,
    activeWorktreeId: snapshot.activeWorktreeId,
    activeTabId: snapshot.activeTabId,
    tabsByWorktree: buildSanitizedTabsByWorktree(snapshot.tabsByWorktree),
    terminalLayoutsByTabId: snapshot.terminalLayoutsByTabId,
    // Why: session:set fully replaces the persisted object, so every write path
    // must carry forward which worktrees still had live PTYs. Dropping this
    // field silently disables eager terminal reconnect on the next restart.
    activeWorktreeIdsOnShutdown: terminalSessionData.activeWorktreeIdsOnShutdown,
    activeTabIdByWorktree: snapshot.activeTabIdByWorktree,
    ...buildEditorSessionData(
      snapshot.openFiles,
      snapshot.editorDrafts,
      snapshot.markdownFrontmatterVisible,
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
    // Why: split creation and tab creation are separate renderer updates.
    // Persist only layouts backed by real tabs so a reload cannot restore a
    // blank split pane from that transient midpoint.
    ...buildPersistedUnifiedTabSessionData(snapshot),
    activeConnectionIdsAtShutdown: buildActiveConnectionIdsAtShutdown(snapshot),
    remoteSessionIdsByTabId: terminalSessionData.remoteSessionIdsByTabId,
    // Why: per-worktree focus-recency for Cmd+J's empty-query ordering.
    // Omit when empty so sessions written by builds that never stamped
    // anything don't bloat the payload. See
    // docs/cmd-j-empty-query-ordering.md.
    lastVisitedAtByWorktreeId: buildLastVisitedAtByWorktreeId(snapshot),
    defaultTerminalTabsAppliedByWorktreeId:
      snapshot.defaultTerminalTabsAppliedByWorktreeId &&
      Object.keys(snapshot.defaultTerminalTabsAppliedByWorktreeId).length > 0
        ? snapshot.defaultTerminalTabsAppliedByWorktreeId
        : undefined,
    ...buildSleepingAgentSessionData(snapshot)
  }

  return pruneLocalTerminalScrollbackBuffers(payload, snapshot.repos)
}
