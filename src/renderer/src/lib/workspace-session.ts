import { rawWorkspaceSnapshot } from '../store/workspace-composition'
import { pendingAgentLaunchPane } from '../../../shared/agent-launch-pane-verdict'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { pruneLocalTerminalScrollbackBuffers } from '../../../shared/workspace-session-terminal-buffers'
import { normalizeBrowserHistoryEntries } from '../../../shared/workspace-session-browser-history'
import { normalizeWorkspaceDocHistoryEntries } from '../../../shared/workspace-doc-history'
import type { AppState } from '../store'
import { buildEditorSessionData } from './workspace-session-editor-files'
export { buildEditorSessionData } from './workspace-session-editor-files'
import { buildPersistedUnifiedTabSessionData } from './workspace-session-unified-tabs'
import { buildLastVisitedAtByWorktreeId } from './workspace-session-focus-recency'
import { buildSleepingAgentSessionData } from './workspace-session-sleeping-agents'
import { buildActiveConnectionIdsAtShutdown } from './workspace-session-reconnect-targets'
import { withoutStagedBrowserTabs } from './workspace-session-staged-browser-tabs'
import { buildBrowserSessionData } from './workspace-session-browser-tabs'
import { pickCloseIntents, type CloseIntentFields } from './workspace-session-close-intents'

export { buildActiveConnectionIdsAtShutdown }

/** Why (issue #1158): require both flags so a hydration failure can't overwrite orca-data.json with empty error-path state. */
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
  | 'localOnlyScrollbackByTabId'
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
  | 'workspaceDocHistory'
  | 'remoteBrowserPageHandlesByPageId'
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
> &
  CloseIntentFields & {
    workspacePresentations?: AppState['workspacePresentations']
    activeWorkspaceExecutionHostId?: AppState['activeWorkspaceExecutionHostId']
    sleepingAgentSessionsByPaneKey?: AppState['sleepingAgentSessionsByPaneKey']
    /** Optional so the many partial snapshot fixtures keep type-checking; see buildTerminalSessionData. */
    pendingReconnectPtyIdByTabId?: AppState['pendingReconnectPtyIdByTabId']
    deferredSshSessionIdsByTabId?: AppState['deferredSshSessionIdsByTabId']
  }

// Why: shallow-equality gate for the debounced session writer; _exhaustive below keeps it in sync with the snapshot type.
export const SESSION_RELEVANT_FIELDS = [
  'workspacePresentations',
  'activeRepoId',
  'activeWorkspaceKey',
  'activeWorkspaceExecutionHostId',
  'activeWorktreeId',
  'activeTabId',
  'tabsByWorktree',
  'ptyIdsByTabId',
  'terminalLayoutsByTabId',
  'localOnlyScrollbackByTabId',
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
  'workspaceDocHistory',
  'remoteBrowserPageHandlesByPageId',
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
  'sleepingAgentSessionsByPaneKey',
  'clientHostedBrowserCloseIntentsByEnvironment',
  'pairedTerminalTabCloseIntentsByEnvironment',
  'pendingReconnectPtyIdByTabId',
  'deferredSshSessionIdsByTabId'
] as const satisfies readonly (keyof WorkspaceSessionSnapshot)[]

type _MissingSessionField = Exclude<
  keyof WorkspaceSessionSnapshot,
  (typeof SESSION_RELEVANT_FIELDS)[number]
>
void (true satisfies [_MissingSessionField] extends [never] ? true : never)

export function buildSanitizedTabsByWorktree(
  tabsByWorktree: WorkspaceSessionSnapshot['tabsByWorktree']
): WorkspaceSessionState['tabsByWorktree'] {
  // Why: strip transient pendingActivationSpawn — session:set persists without Zod re-parse, so a stale flag would drop the first PTY spawn on restart.
  // Same for the recovery ledger: it describes a mounted pane's in-flight heal, so a persisted one would refuse the first recovery after restart.
  // A launch pane's outcome is not saved: a reload asks main again, which keeps it until it quits; after a restart the pane spawns like any other.
  return Object.fromEntries(
    Object.entries(tabsByWorktree).map(([worktreeId, tabs]) => [
      worktreeId,
      tabs.map((tab) => {
        const {
          pendingActivationSpawn: _unused,
          recovery: _recovery,
          restoredFromSession: _restored,
          ...rest
        } = tab
        void _unused
        void _recovery
        void _restored
        return rest.agentLaunchPane
          ? { ...rest, agentLaunchPane: pendingAgentLaunchPane(rest.agentLaunchPane) }
          : rest
      })
    ])
  )
}

export function buildTerminalSessionData(
  snapshot: WorkspaceSessionSnapshot
): Pick<WorkspaceSessionState, 'activeWorktreeIdsOnShutdown' | 'remoteSessionIdsByTabId'> {
  const tabsByWorktree = snapshot.tabsByWorktree

  // Why: use ptyIdsByTabId (live PTYs), not tab.ptyId, which sleep preserves as a wake hint and would revive slept worktrees as active.
  const ptyIdsByTabId = snapshot.ptyIdsByTabId
  const hasLivePty = (tabId: string): boolean => (ptyIdsByTabId[tabId]?.length ?? 0) > 0

  // Why: relay reconnect keeps lastKnown but clears tab.ptyId; the !tab.ptyId guard excludes slept tabs (which keep ptyId as a wake hint).
  const lastKnown = snapshot.lastKnownRelayPtyIdByTabId
  // During fresh hydration reconnect maps alone retain relay handles after live/tab bindings clear (#17743); omitting them republishes temporary absence over surviving sessions.
  const pendingReconnect = snapshot.pendingReconnectPtyIdByTabId ?? {}
  const deferredSshSessions = snapshot.deferredSshSessionIdsByTabId ?? {}
  const restoredSessionId = (tabId: string): string | undefined =>
    lastKnown[tabId] || pendingReconnect[tabId] || deferredSshSessions[tabId]
  const hasReconnectableSession = (tab: { id: string; ptyId: string | null }): boolean =>
    hasLivePty(tab.id) || (!tab.ptyId && Boolean(restoredSessionId(tab.id)))

  const activeWorktreeIdsOnShutdown = Object.entries(tabsByWorktree)
    .filter(([, tabs]) => tabs.some(hasReconnectableSession))
    .map(([worktreeId]) => worktreeId)

  const worktreeById = new Map(
    Object.values(snapshot.worktreesByRepo)
      .flat()
      .map((worktree) => [worktree.id, worktree])
  )
  const repoById = new Map(snapshot.repos.map((repo) => [repo.id, repo]))

  // Derive reconnect targets locally with preindexed ownership; fragile synchronous IPC can drop under shutdown pressure, while per-tab catalog rescans delay quit.
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
      const sessionId = tab.ptyId || restoredSessionId(tab.id)
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

export function buildWorkspaceSessionPayload(
  fullSnapshot: WorkspaceSessionSnapshot
): WorkspaceSessionState {
  const snapshot = withoutStagedBrowserTabs(rawWorkspaceSnapshot(fullSnapshot))
  const terminalSessionData = buildTerminalSessionData(snapshot)

  const payload = {
    activeRepoId: snapshot.activeRepoId,
    activeWorkspaceKey: snapshot.activeWorkspaceKey,
    activeWorkspaceExecutionHostId: snapshot.activeWorkspaceExecutionHostId,
    activeWorktreeId: snapshot.activeWorktreeId,
    activeTabId: snapshot.activeTabId,
    tabsByWorktree: buildSanitizedTabsByWorktree(snapshot.tabsByWorktree),
    terminalLayoutsByTabId: snapshot.terminalLayoutsByTabId,
    localOnlyScrollbackByTabId: snapshot.localOnlyScrollbackByTabId,
    // Why: session:set fully replaces the persisted object, so dropping this silently disables eager terminal reconnect on restart.
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
      snapshot.activeBrowserTabIdByWorktree,
      snapshot.remoteBrowserPageHandlesByPageId
    ),
    // Why: enforce the history storage cap here so stale renderer state can't make every write stringify an oversized legacy array.
    browserUrlHistory: normalizeBrowserHistoryEntries(snapshot.browserUrlHistory),
    workspaceDocHistory: normalizeWorkspaceDocHistoryEntries(snapshot.workspaceDocHistory ?? []),
    // Why: persist only layouts backed by real tabs so a reload can't restore a blank split pane from the split-before-tab midpoint.
    ...buildPersistedUnifiedTabSessionData(snapshot),
    activeConnectionIdsAtShutdown: buildActiveConnectionIdsAtShutdown(
      snapshot,
      terminalSessionData.remoteSessionIdsByTabId ?? null
    ),
    remoteSessionIdsByTabId: terminalSessionData.remoteSessionIdsByTabId,
    // Why: omit when empty so builds that never stamped focus-recency don't bloat the payload. See docs/cmd-j-empty-query-ordering.md.
    lastVisitedAtByWorktreeId: buildLastVisitedAtByWorktreeId(snapshot),
    defaultTerminalTabsAppliedByWorktreeId:
      snapshot.defaultTerminalTabsAppliedByWorktreeId &&
      Object.keys(snapshot.defaultTerminalTabsAppliedByWorktreeId).length > 0
        ? snapshot.defaultTerminalTabsAppliedByWorktreeId
        : undefined,
    ...buildSleepingAgentSessionData(snapshot),
    ...pickCloseIntents(snapshot)
  }

  return pruneLocalTerminalScrollbackBuffers(payload, snapshot.repos)
}
