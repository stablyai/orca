/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  SetupSplitDirection,
  TerminalLayoutSnapshot,
  TerminalTab,
  Worktree,
  WorkspaceSessionState
} from '../../../../shared/types'
import type { AgentStartedTelemetry } from '../../lib/worktree-activation'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { clearTransientTerminalState, emptyLayoutSnapshot } from './terminal-helpers'
import { isClaudeAgent, detectAgentStatusFromTitle } from '@/lib/agent-status'
import { buildOrphanTerminalCleanupPatch, getOrphanTerminalIds } from './terminal-orphan-helpers'
import {
  dedupeTabOrder,
  ensureGroup,
  findTabByEntityInGroup,
  pushRecentTabId,
  sanitizeRecentTabIds,
  updateGroup
} from './tab-group-state'
import {
  ensurePtyDispatcher,
  unregisterPtyDataHandlers
} from '@/components/terminal-pane/pty-transport'
import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'

function getNextTerminalOrdinal(tabs: TerminalTab[]): number {
  const usedOrdinals = new Set<number>()
  for (const tab of tabs) {
    const match = /^Terminal (\d+)$/.exec(tab.defaultTitle ?? tab.title)
    if (!match) {
      continue
    }
    usedOrdinals.add(Number(match[1]))
  }

  let nextOrdinal = 1
  while (usedOrdinals.has(nextOrdinal)) {
    nextOrdinal += 1
  }
  return nextOrdinal
}

function getFallbackTabTitle(tab: TerminalTab, index?: number): string {
  return (
    tab.customTitle?.trim() ||
    tab.defaultTitle?.trim() ||
    tab.title ||
    `Terminal ${(index ?? 0) + 1}`
  )
}

export type TerminalSlice = {
  tabsByWorktree: Record<string, TerminalTab[]>
  activeTabId: string | null
  /** Per-worktree last-active terminal tab — restored on worktree switch so
   *  the user returns to the same tab they left, not always tabs[0]. */
  activeTabIdByWorktree: Record<string, string | null>
  ptyIdsByTabId: Record<string, string[]>
  /** Live pane titles keyed by tabId then paneId. Unlike the legacy tab title,
   *  this preserves split-pane agent status per pane while TerminalPane is mounted. */
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  /** Why: per-tab activity indicators. A tab gets flagged unread when an
   *  agent in any of its panes transitions working→idle (onAgentBecameIdle
   *  in pty-connection.ts) while the tab is not currently focused. The flag
   *  clears when the user activates the tab. This is ephemeral UI state
   *  only — not persisted across restarts.
   *
   *  Note: BEL (0x07) bytes intentionally do NOT flip this flag. See the
   *  long-form rationale in pty-connection.ts around `onAgentBecameIdle`
   *  for why BEL is too ambiguous to drive cross-surface attention. */
  unreadTerminalTabs: Record<string, true>
  suppressedPtyExitIds: Record<string, true>
  pendingCodexPaneRestartIds: Record<string, true>
  codexRestartNoticeByPtyId: Record<
    string,
    { previousAccountLabel: string; nextAccountLabel: string }
  >
  expandedPaneByTabId: Record<string, boolean>
  canExpandPaneByTabId: Record<string, boolean>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  pendingStartupByTabId: Record<
    string,
    {
      command: string
      env?: Record<string, string>
      /** Telemetry metadata for the `agent_started` event. Threaded all the
       *  way to the `pty:spawn` IPC handler in main so the event fires only
       *  after spawn confirms — never on click-intent. */
      telemetry?: AgentStartedTelemetry
    }
  >
  /** Queued setup-split requests — when present, TerminalPane creates the
   *  initial pane clean, then splits (vertical or horizontal per user setting)
   *  and runs the command in the new pane so the main terminal stays
   *  immediately interactive. */
  pendingSetupSplitByTabId: Record<
    string,
    { command: string; env?: Record<string, string>; direction: SetupSplitDirection }
  >
  /** Queued issue-command-split requests — similar to setup splits but triggered
   *  when an issue is linked during worktree creation and the repo's issue
   *  automation command is enabled. */
  pendingIssueCommandSplitByTabId: Record<string, { command: string; env?: Record<string, string> }>
  tabBarOrderByWorktree: Record<string, string[]>
  workspaceSessionReady: boolean
  pendingReconnectWorktreeIds: string[]
  pendingReconnectTabByWorktree: Record<string, string[]>
  /** Maps tabId → previous ptyId from the last session. When the PTY backend is
   *  a daemon, the old ptyId doubles as the daemon sessionId — passing it to
   *  spawn triggers createOrAttach which returns the surviving terminal snapshot. */
  pendingReconnectPtyIdByTabId: Record<string, string>
  // Why: relay session IDs (e.g. pty-0) are stored in tab.ptyId, but
  // clearTabPtyId nulls it on disconnect.  This map preserves the last
  // known ID so the session save can capture it even when the relay mux
  // is temporarily down — without it, remoteSessionIdsByTabId would be
  // empty and the relay PTY could not be reattached after restart.
  lastKnownRelayPtyIdByTabId: Record<string, string>
  /** ANSI snapshots returned by daemon reattach, keyed by the new ptyId.
   *  TerminalPane writes these to xterm.js to restore visual state. */
  pendingSnapshotByPtyId: Record<
    string,
    { snapshot: string; cols?: number; rows?: number; isAlternateScreen?: boolean }
  >
  consumePendingSnapshot: (
    ptyId: string
  ) => { snapshot: string; cols?: number; rows?: number; isAlternateScreen?: boolean } | null
  /** Cold restore data from disk history after a daemon crash, keyed by
   *  the new ptyId. Contains read-only scrollback to display above the
   *  fresh shell prompt. */
  pendingColdRestoreByPtyId: Record<string, { scrollback: string; cwd: string }>
  consumePendingColdRestore: (ptyId: string) => { scrollback: string; cwd: string } | null
  createTab: (
    worktreeId: string,
    targetGroupId?: string,
    shellOverride?: string,
    options?: { pendingActivationSpawn?: boolean }
  ) => TerminalTab
  closeTab: (tabId: string) => void
  reorderTabs: (worktreeId: string, tabIds: string[]) => void
  setTabBarOrder: (worktreeId: string, order: string[]) => void
  setActiveTab: (tabId: string) => void
  updateTabTitle: (tabId: string, title: string) => void
  setRuntimePaneTitle: (tabId: string, paneId: number, title: string) => void
  clearRuntimePaneTitle: (tabId: string, paneId: number) => void
  /** Mark a tab as having unread activity (agent working→idle transition).
   *  Skipped when the tab is currently visible to the user — either as
   *  the global active terminal tab, or as the active tab of any split
   *  group within the active worktree. A visible tab is already "seen",
   *  so a flag would never clear naturally. */
  markTerminalTabUnread: (tabId: string) => void
  /** Clear a tab's unread indicator. Called on user interaction with the
   *  pane (keystroke, click) — matches ghostty's "show until interact"
   *  model where the bell stays visible until the user engages with the
   *  surface that raised it. */
  clearTerminalTabUnread: (tabId: string) => void
  setTabCustomTitle: (tabId: string, title: string | null) => void
  setTabColor: (tabId: string, color: string | null) => void
  updateTabPtyId: (tabId: string, ptyId: string) => void
  clearTabPtyId: (tabId: string, ptyId?: string) => void
  shutdownWorktreeTerminals: (
    worktreeId: string,
    opts?: { keepIdentifiers?: boolean }
  ) => Promise<void>
  suppressPtyExit: (ptyId: string) => void
  consumeSuppressedPtyExit: (ptyId: string) => boolean
  queueCodexPaneRestarts: (ptyIds: string[]) => void
  consumePendingCodexPaneRestart: (ptyId: string) => boolean
  markCodexRestartNotices: (
    notices: { ptyId: string; previousAccountLabel: string; nextAccountLabel: string }[]
  ) => void
  clearCodexRestartNotice: (ptyId: string) => void
  setTabPaneExpanded: (tabId: string, expanded: boolean) => void
  setTabCanExpandPane: (tabId: string, canExpand: boolean) => void
  setTabLayout: (tabId: string, layout: TerminalLayoutSnapshot | null) => void
  queueTabStartupCommand: (
    tabId: string,
    startup: {
      command: string
      env?: Record<string, string>
      telemetry?: AgentStartedTelemetry
    }
  ) => void
  consumeTabStartupCommand: (
    tabId: string
  ) => { command: string; env?: Record<string, string>; telemetry?: AgentStartedTelemetry } | null
  queueTabSetupSplit: (
    tabId: string,
    startup: { command: string; env?: Record<string, string>; direction: SetupSplitDirection }
  ) => void
  consumeTabSetupSplit: (
    tabId: string
  ) => { command: string; env?: Record<string, string>; direction: SetupSplitDirection } | null
  queueTabIssueCommandSplit: (
    tabId: string,
    issueCommand: { command: string; env?: Record<string, string> }
  ) => void
  consumeTabIssueCommandSplit: (
    tabId: string
  ) => { command: string; env?: Record<string, string> } | null
  /** Per-pane timestamp (ms) when the prompt-cache countdown started (agent became idle).
   *  Keys are `${tabId}:${paneId}` composites so split-pane tabs can track each pane
   *  independently. null means no active timer for that pane. */
  cacheTimerByKey: Record<string, number | null>
  setCacheTimerStartedAt: (key: string, ts: number | null) => void
  /** Scan all tabs and seed cache timers for any idle Claude sessions that don't
   *  already have a timer. Called when the feature is enabled mid-session. */
  seedCacheTimersForIdleTabs: () => void
  /** SSH target IDs that require a passphrase — deferred to on-demand
   *  reconnect when the user focuses an affected terminal tab. */
  deferredSshReconnectTargets: string[]
  /** Maps tabId → remote PTY session ID for tabs whose SSH target was
   *  deferred (passphrase-protected). Persisted across the startup clear
   *  of pendingReconnectPtyIdByTabId because the deferred reconnect runs
   *  later, on tab focus. */
  deferredSshSessionIdsByTabId: Record<string, string>
  setDeferredSshReconnectTargets: (targetIds: string[]) => void
  removeDeferredSshReconnectTarget: (targetId: string) => void
  removeDeferredSshSessionId: (tabId: string) => void
  hydrateWorkspaceSession: (session: WorkspaceSessionState) => void
  reconnectPersistedTerminals: (signal?: AbortSignal) => Promise<void>
}

export const createTerminalSlice: StateCreator<AppState, [], [], TerminalSlice> = (set, get) => ({
  tabsByWorktree: {},
  activeTabId: null,
  activeTabIdByWorktree: {},
  ptyIdsByTabId: {},
  runtimePaneTitlesByTabId: {},
  unreadTerminalTabs: {},
  suppressedPtyExitIds: {},
  pendingCodexPaneRestartIds: {},
  codexRestartNoticeByPtyId: {},
  expandedPaneByTabId: {},
  canExpandPaneByTabId: {},
  terminalLayoutsByTabId: {},
  pendingStartupByTabId: {},
  pendingSetupSplitByTabId: {},
  pendingIssueCommandSplitByTabId: {},
  tabBarOrderByWorktree: {},
  workspaceSessionReady: false,
  pendingReconnectWorktreeIds: [],
  pendingReconnectTabByWorktree: {},
  pendingReconnectPtyIdByTabId: {},
  lastKnownRelayPtyIdByTabId: {},
  pendingSnapshotByPtyId: {},
  pendingColdRestoreByPtyId: {},
  deferredSshReconnectTargets: [],
  deferredSshSessionIdsByTabId: {},
  cacheTimerByKey: {},

  setCacheTimerStartedAt: (key, ts) => {
    set((s) => {
      const next = { ...s.cacheTimerByKey, [key]: ts }
      // Why: when a real pane transition writes a key like `${tabId}:${paneId}`,
      // clean up any `${tabId}:seed` sentinel left by seedCacheTimersForIdleTabs.
      // This prevents phantom timers when the seeded key doesn't match the real
      // pane ID (e.g., idle Claude in pane 2 of a split tab).
      const colonIdx = key.indexOf(':')
      if (colonIdx !== -1) {
        const tabId = key.slice(0, colonIdx)
        const suffix = key.slice(colonIdx + 1)
        if (suffix !== 'seed') {
          delete next[`${tabId}:seed`]
        }
      }
      return { cacheTimerByKey: next }
    })
  },

  seedCacheTimersForIdleTabs: () => {
    // Why: when the user enables the cache timer feature mid-session, any Claude
    // tabs that are already idle won't have a timer because the working→idle
    // transition already happened. Scan all tabs and seed timers for idle Claude
    // sessions that don't already have one.
    const s = get()
    const now = Date.now()
    const updates: Record<string, number> = {}
    for (const tabs of Object.values(s.tabsByWorktree)) {
      for (const tab of tabs) {
        if (!tab.title || !isClaudeAgent(tab.title)) {
          continue
        }
        const status = detectAgentStatusFromTitle(tab.title)
        if (status === null || status === 'working') {
          continue
        }
        // Why: the store doesn't know which pane holds the idle Claude session,
        // so we use a sentinel suffix. The `setCacheTimerStartedAt` action
        // automatically cleans up `:seed` entries when any real pane transition
        // writes to the same tab, preventing phantom timers.
        const key = `${tab.id}:seed`
        if (s.cacheTimerByKey[key] == null) {
          updates[key] = now
        }
      }
    }
    if (Object.keys(updates).length > 0) {
      set((s) => ({
        cacheTimerByKey: { ...s.cacheTimerByKey, ...updates }
      }))
    }
  },

  setDeferredSshReconnectTargets: (targetIds) => set({ deferredSshReconnectTargets: targetIds }),
  removeDeferredSshReconnectTarget: (targetId) =>
    set((s) => ({
      deferredSshReconnectTargets: s.deferredSshReconnectTargets.filter((id) => id !== targetId)
    })),
  removeDeferredSshSessionId: (tabId) =>
    set((s) => {
      if (!s.deferredSshSessionIdsByTabId[tabId]) {
        return {}
      }
      const next = { ...s.deferredSshSessionIdsByTabId }
      delete next[tabId]
      return { deferredSshSessionIdsByTabId: next }
    }),

  createTab: (worktreeId, targetGroupId, shellOverride, options) => {
    const id = globalThis.crypto.randomUUID()
    let tab!: TerminalTab
    set((s) => {
      const orphanTerminalIds = getOrphanTerminalIds(s, worktreeId)
      const orphanCleanupPatch = buildOrphanTerminalCleanupPatch(s, worktreeId, orphanTerminalIds)
      const existing = (s.tabsByWorktree[worktreeId] ?? []).filter(
        (entry) => !orphanTerminalIds.has(entry.id)
      )
      const nextOrdinal = getNextTerminalOrdinal(existing)
      const defaultTitle = `Terminal ${nextOrdinal}`
      tab = {
        id,
        ptyId: null,
        worktreeId,
        // Why: users expect terminal labels to reflect the currently open set,
        // not a monotonic creation counter. Reusing the lowest free ordinal
        // keeps a lone fresh terminal at "Terminal 1" after older tabs close.
        title: defaultTitle,
        defaultTitle,
        customTitle: null,
        color: null,
        sortOrder: existing.length,
        createdAt: Date.now(),
        ...(shellOverride !== undefined ? { shellOverride } : {}),
        // Why: when Terminal.tsx's activation fallback auto-creates a tab for a
        // first-visit worktree, the resulting PTY spawn is caused by the user
        // clicking the worktree, not by work happening in it. Tagging the tab
        // lets updateTabPtyId suppress the activity bump and sortEpoch bump.
        // Without this, clicking a never-visited worktree would stamp
        // lastActivityAt and reorder Recent/Smart on click — same bug class as
        // the generation-bump → remount path, different code path.
        ...(options?.pendingActivationSpawn ? { pendingActivationSpawn: true } : {})
      }
      const validTargetGroupId =
        targetGroupId && s.groupsByWorktree[worktreeId]?.some((group) => group.id === targetGroupId)
          ? targetGroupId
          : undefined
      const { group, groupsByWorktree, activeGroupIdByWorktree } = ensureGroup(
        s.groupsByWorktree,
        s.activeGroupIdByWorktree,
        worktreeId,
        validTargetGroupId ?? s.activeGroupIdByWorktree[worktreeId]
      )
      const nextActiveGroupIdByWorktree = validTargetGroupId
        ? { ...activeGroupIdByWorktree, [worktreeId]: validTargetGroupId }
        : activeGroupIdByWorktree
      const existingUnifiedTabs = s.unifiedTabsByWorktree[worktreeId] ?? []
      const existingTerminalTab = findTabByEntityInGroup(
        s.unifiedTabsByWorktree,
        worktreeId,
        group.id,
        id,
        'terminal'
      )
      const unifiedTab = existingTerminalTab ?? {
        id,
        entityId: id,
        groupId: group.id,
        worktreeId,
        contentType: 'terminal' as const,
        label: tab.title,
        customLabel: tab.customTitle,
        color: tab.color,
        sortOrder: dedupeTabOrder(group.tabOrder).length,
        createdAt: tab.createdAt
      }
      const nextGroupOrder = dedupeTabOrder([...group.tabOrder, unifiedTab.id])
      const nextRecent = pushRecentTabId(
        sanitizeRecentTabIds(group.recentTabIds, nextGroupOrder),
        unifiedTab.id
      )
      return {
        ...orphanCleanupPatch,
        tabsByWorktree: {
          ...orphanCleanupPatch.tabsByWorktree,
          [worktreeId]: [...existing, tab]
        },
        // Why: task-page launch queues startup/setup work before React mounts
        // the terminal. Publishing the unified tab atomically with the runtime
        // tab prevents a transient legacy mount from racing the split host.
        unifiedTabsByWorktree: {
          ...s.unifiedTabsByWorktree,
          [worktreeId]: existingTerminalTab
            ? existingUnifiedTabs
            : [...existingUnifiedTabs, unifiedTab]
        },
        groupsByWorktree: {
          ...groupsByWorktree,
          [worktreeId]: updateGroup(groupsByWorktree[worktreeId] ?? [], {
            ...group,
            activeTabId: unifiedTab.id,
            tabOrder: nextGroupOrder,
            recentTabIds: nextRecent
          })
        },
        activeGroupIdByWorktree: nextActiveGroupIdByWorktree,
        layoutByWorktree: {
          ...s.layoutByWorktree,
          [worktreeId]: s.layoutByWorktree[worktreeId] ?? { type: 'leaf', groupId: group.id }
        },
        activeTabId: tab.id,
        activeTabIdByWorktree: { ...s.activeTabIdByWorktree, [worktreeId]: tab.id },
        ptyIdsByTabId: { ...s.ptyIdsByTabId, [tab.id]: [] },
        terminalLayoutsByTabId: {
          ...s.terminalLayoutsByTabId,
          [tab.id]: emptyLayoutSnapshot()
        }
      }
    })
    return tab
  },

  closeTab: (tabId) => {
    set((s) => {
      const next = { ...s.tabsByWorktree }
      let closingPtyId: string | null = null
      for (const wId of Object.keys(next)) {
        const before = next[wId]
        if (!closingPtyId) {
          closingPtyId = before.find((t) => t.id === tabId)?.ptyId ?? null
        }
        const after = before.filter((t) => t.id !== tabId)
        if (after.length !== before.length) {
          next[wId] = after
        }
      }
      const nextExpanded = { ...s.expandedPaneByTabId }
      delete nextExpanded[tabId]
      const nextCanExpand = { ...s.canExpandPaneByTabId }
      delete nextCanExpand[tabId]
      const nextLayouts = { ...s.terminalLayoutsByTabId }
      delete nextLayouts[tabId]
      const nextPtyIdsByTabId = { ...s.ptyIdsByTabId }
      delete nextPtyIdsByTabId[tabId]
      const nextLastKnownRelay = { ...s.lastKnownRelayPtyIdByTabId }
      delete nextLastKnownRelay[tabId]
      const nextRuntimePaneTitlesByTabId = { ...s.runtimePaneTitlesByTabId }
      delete nextRuntimePaneTitlesByTabId[tabId]
      // Why: preserve the unreadTerminalTabs reference when the closing tab had
      // no unread flag — avoids a no-op top-level state allocation that would
      // force re-evaluation of full-state selectors on unrelated closeTab calls.
      // Mirrors the sibling pattern in tabs.ts (focusGroup, reconcileWorktreeTabModel).
      let nextUnreadTerminalTabs = s.unreadTerminalTabs
      if (s.unreadTerminalTabs[tabId]) {
        nextUnreadTerminalTabs = { ...s.unreadTerminalTabs }
        delete nextUnreadTerminalTabs[tabId]
      }
      const nextPendingStartupByTabId = { ...s.pendingStartupByTabId }
      delete nextPendingStartupByTabId[tabId]
      const nextPendingSetupSplitByTabId = { ...s.pendingSetupSplitByTabId }
      delete nextPendingSetupSplitByTabId[tabId]
      const nextPendingIssueCommandSplitByTabId = { ...s.pendingIssueCommandSplitByTabId }
      delete nextPendingIssueCommandSplitByTabId[tabId]
      const nextCacheTimer = { ...s.cacheTimerByKey }
      // Why: cache timer keys are `${tabId}:${paneId}` composites. Remove all
      // entries for the closing tab, regardless of how many panes it had.
      for (const key of Object.keys(nextCacheTimer)) {
        if (key.startsWith(`${tabId}:`)) {
          delete nextCacheTimer[key]
        }
      }
      // Why: keep activeTabIdByWorktree in sync when a tab is closed in a
      // background worktree. Without this, the remembered tab becomes stale
      // and restoring it on worktree switch falls back to tabs[0].
      const nextActiveTabIdByWorktree = { ...s.activeTabIdByWorktree }
      for (const [wId, tabs] of Object.entries(next)) {
        if (nextActiveTabIdByWorktree[wId] === tabId) {
          nextActiveTabIdByWorktree[wId] = tabs[0]?.id ?? null
        }
      }

      // Why: keep tabBarOrderByWorktree in sync so stale terminal IDs don't
      // linger and cause position shifts on subsequent tab operations.
      const nextTabBarOrderByWorktree: Record<string, string[]> = {
        ...s.tabBarOrderByWorktree
      }
      for (const wId of Object.keys(nextTabBarOrderByWorktree)) {
        const order = nextTabBarOrderByWorktree[wId]
        if (order?.includes(tabId)) {
          nextTabBarOrderByWorktree[wId] = order.filter((entryId) => entryId !== tabId)
        }
      }

      // Why: if the tab had a ptyId with unconsumed snapshot or cold restore
      // data (e.g., tab closed before TerminalPane mounted), clean it up to
      // prevent unbounded store growth across restarts.
      let nextSnapshots = s.pendingSnapshotByPtyId
      let nextColdRestores = s.pendingColdRestoreByPtyId
      if (closingPtyId) {
        if (closingPtyId in nextSnapshots) {
          nextSnapshots = { ...nextSnapshots }
          delete nextSnapshots[closingPtyId]
        }
        if (closingPtyId in nextColdRestores) {
          nextColdRestores = { ...nextColdRestores }
          delete nextColdRestores[closingPtyId]
        }
      }

      return {
        tabsByWorktree: next,
        activeTabId: s.activeTabId === tabId ? null : s.activeTabId,
        activeTabIdByWorktree: nextActiveTabIdByWorktree,
        ptyIdsByTabId: nextPtyIdsByTabId,
        lastKnownRelayPtyIdByTabId: nextLastKnownRelay,
        runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId,
        // Why: skip writing unreadTerminalTabs when the reference is unchanged —
        // avoids a no-op top-level state allocation that would force re-evaluation
        // of full-state selectors. Mirrors the sibling pattern in tabs.ts.
        ...(nextUnreadTerminalTabs !== s.unreadTerminalTabs
          ? { unreadTerminalTabs: nextUnreadTerminalTabs }
          : {}),
        expandedPaneByTabId: nextExpanded,
        canExpandPaneByTabId: nextCanExpand,
        terminalLayoutsByTabId: nextLayouts,
        pendingStartupByTabId: nextPendingStartupByTabId,
        pendingSetupSplitByTabId: nextPendingSetupSplitByTabId,
        pendingIssueCommandSplitByTabId: nextPendingIssueCommandSplitByTabId,
        cacheTimerByKey: nextCacheTimer,
        tabBarOrderByWorktree: nextTabBarOrderByWorktree,
        pendingSnapshotByPtyId: nextSnapshots,
        pendingColdRestoreByPtyId: nextColdRestores
      }
    })
    // Why: sweep live AND retained agent-status entries for this tab — closing
    // the tab is the user telling us "I'm done with this session", so any
    // completion snapshots it left behind (in the inline agents list) must go
    // too. Use dropAgentStatusByTabPrefix (not removeAgentStatusByTabPrefix)
    // so retention suppressors are planted: a live→gone transition inside the
    // same frame as the tab close cannot re-snapshot a row we just dropped.
    get().dropAgentStatusByTabPrefix(tabId)
    for (const tabs of Object.values(get().unifiedTabsByWorktree)) {
      const workspaceItem = tabs.find(
        (entry) => entry.contentType === 'terminal' && entry.entityId === tabId
      )
      if (workspaceItem) {
        get().closeUnifiedTab(workspaceItem.id)
      }
    }
  },

  reorderTabs: (worktreeId, tabIds) => {
    set((s) => {
      const tabs = s.tabsByWorktree[worktreeId] ?? []
      const tabMap = new Map(tabs.map((t) => [t.id, t]))
      const orderedSet = new Set(tabIds)
      const missingTabs = tabs.filter((t) => !orderedSet.has(t.id))

      const reordered = [
        ...tabIds.map((id) => tabMap.get(id)!).filter(Boolean),
        ...missingTabs
      ].map((tab, i) => ({ ...tab, sortOrder: i }))

      return {
        tabsByWorktree: { ...s.tabsByWorktree, [worktreeId]: reordered }
      }
    })
  },

  setTabBarOrder: (worktreeId, order) => {
    set((s) => {
      // Update unified visual order
      const newTabBarOrder = { ...s.tabBarOrderByWorktree, [worktreeId]: order }

      // Keep terminal tab sortOrder in sync for persistence
      const tabs = s.tabsByWorktree[worktreeId]
      if (!tabs) {
        return { tabBarOrderByWorktree: newTabBarOrder }
      }
      const tabMap = new Map(tabs.map((t) => [t.id, t]))
      // Extract terminal IDs in their new relative order
      const terminalIdsInOrder = order.filter((id) => tabMap.has(id))
      const orderedSet = new Set(terminalIdsInOrder)
      const missingTabs = tabs.filter((t) => !orderedSet.has(t.id))

      const updatedTabs = [
        ...terminalIdsInOrder.map((id) => tabMap.get(id)!).filter(Boolean),
        ...missingTabs
      ].map((tab, i) => ({ ...tab, sortOrder: i }))

      return {
        tabBarOrderByWorktree: newTabBarOrder,
        tabsByWorktree: { ...s.tabsByWorktree, [worktreeId]: updatedTabs }
      }
    })
  },

  setActiveTab: (tabId) => {
    set((s) => {
      // Why: focusing a terminal tab clears the tab-level bell — the user has
      // moved to this tab.
      //
      // Why (activeWorktree guard below): only clear when the tab belongs to
      // the active worktree. If setActiveTab is invoked with a tab from a
      // background worktree (e.g., during worktree activation, or the
      // "jump to agent" path), the tab is not yet visible and clearing would
      // silently swallow the signal. Mirrors the guard in activateTab and
      // focusGroup.
      let tabOwnerWorktreeId: string | null = null
      for (const [wId, tabs] of Object.entries(s.tabsByWorktree)) {
        if (tabs.some((t) => t.id === tabId)) {
          tabOwnerWorktreeId = wId
          break
        }
      }
      const nextUnreadTerminalTabs =
        tabOwnerWorktreeId === s.activeWorktreeId && s.unreadTerminalTabs[tabId]
          ? (() => {
              const copy = { ...s.unreadTerminalTabs }
              delete copy[tabId]
              return copy
            })()
          : s.unreadTerminalTabs
      // Why: only write the global activeTabId when the tab belongs to the
      // currently active worktree. markTerminalTabUnread treats activeTabId
      // as "the tab the user is looking at" and suppresses BELs on it; if we
      // pinned activeTabId to a background-worktree tab (e.g. the
      // jump-to-agent path calls setActiveTab before switching worktrees),
      // a subsequent BEL on that tab would be silently swallowed. The
      // per-worktree map still gets updated so the background worktree
      // remembers its last-active tab for later restoration. Mirrors the
      // pattern already used above for nextUnreadTerminalTabs.
      const isActiveWorktreeTab = tabOwnerWorktreeId === s.activeWorktreeId
      return {
        activeTabId: isActiveWorktreeTab ? tabId : s.activeTabId,
        activeTabIdByWorktree: tabOwnerWorktreeId
          ? { ...s.activeTabIdByWorktree, [tabOwnerWorktreeId]: tabId }
          : s.activeTabIdByWorktree,
        unreadTerminalTabs: nextUnreadTerminalTabs
      }
    })
    const item = Object.values(get().unifiedTabsByWorktree)
      .flat()
      .find((entry) => entry.contentType === 'terminal' && entry.entityId === tabId)
    if (item) {
      get().activateTab(item.id)
    }
  },

  updateTabTitle: (tabId, title) => {
    set((s) => {
      // Why: locate the owning worktree and mutate only that entry in
      // tabsByWorktree. Rebuilding every worktree's tab array (even when
      // unchanged) would break shallow-equality checks in unrelated
      // selectors and trigger spurious re-renders across background
      // worktrees on every OSC title frame.
      let ownerWorktreeId: string | null = null
      let ownerTabs: TerminalTab[] | null = null
      for (const [wId, tabs] of Object.entries(s.tabsByWorktree)) {
        const idx = tabs.findIndex((t) => t.id === tabId)
        if (idx === -1) {
          continue
        }
        const t = tabs[idx]
        const nextTitle = title.trim() || getFallbackTabTitle(t)
        if (t.title === nextTitle) {
          return s
        }
        ownerWorktreeId = wId
        ownerTabs = tabs.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                // Why: PTYs can briefly emit an empty title while an agent exits.
                // Keep the stable fallback label instead of rendering a blank tab.
                title: nextTitle,
                defaultTitle:
                  tab.defaultTitle ??
                  (/^Terminal \d+$/.test(tab.title) ? tab.title : undefined) ??
                  (/^Terminal \d+$/.test(nextTitle) ? nextTitle : undefined)
              }
            : tab
        )
        break
      }
      if (!ownerWorktreeId || !ownerTabs) {
        return s
      }
      scheduleRuntimeGraphSync()
      const nextTabsByWorktree = { ...s.tabsByWorktree, [ownerWorktreeId]: ownerTabs }
      // Agent status is derived from terminal titles and affects sort scoring,
      // so a title change is a meaningful event that should allow re-sort —
      // but only for background worktrees. Title changes in the active
      // worktree are side-effects of PTY reconnection during worktree
      // activation (generation bump → TerminalPane remount → new shell →
      // title update). Bumping sortEpoch here would reorder the sidebar
      // on click — the exact bug PR #209 intended to fix.
      const isActive = ownerWorktreeId === s.activeWorktreeId
      return isActive
        ? { tabsByWorktree: nextTabsByWorktree }
        : { tabsByWorktree: nextTabsByWorktree, sortEpoch: s.sortEpoch + 1 }
    })
    const item = Object.values(get().unifiedTabsByWorktree)
      .flat()
      .find((entry) => entry.contentType === 'terminal' && entry.entityId === tabId)
    if (item) {
      const resolvedTitle =
        Object.values(get().tabsByWorktree)
          .flat()
          .find((tab) => tab.id === tabId)?.title ?? title.trim()
      get().setTabLabel(item.id, resolvedTitle)
    }
  },

  setRuntimePaneTitle: (tabId, paneId, title) => {
    set((s) => {
      const currentByPane = s.runtimePaneTitlesByTabId[tabId] ?? {}
      if (currentByPane[paneId] === title) {
        return s
      }
      return {
        runtimePaneTitlesByTabId: {
          ...s.runtimePaneTitlesByTabId,
          [tabId]: { ...currentByPane, [paneId]: title }
        }
      }
    })
  },

  clearRuntimePaneTitle: (tabId, paneId) => {
    set((s) => {
      const currentByPane = s.runtimePaneTitlesByTabId[tabId]
      if (!currentByPane || !(paneId in currentByPane)) {
        return s
      }
      const nextByPane = { ...currentByPane }
      delete nextByPane[paneId]

      const next = { ...s.runtimePaneTitlesByTabId }
      if (Object.keys(nextByPane).length > 0) {
        next[tabId] = nextByPane
      } else {
        delete next[tabId]
      }

      return { runtimePaneTitlesByTabId: next }
    })
  },

  markTerminalTabUnread: (tabId) => {
    const state = get()
    const ownerTab = Object.values(state.tabsByWorktree ?? {})
      .flat()
      .find((t) => t.id === tabId)
    if (!ownerTab) {
      return
    }
    // Why: BEL must fire regardless of focus (ghostty semantics — "show
    // until interact"). A BEL on the focused tab sets the indicator; real
    // user interaction with the pane dismisses it. Keystroke/pointerdown
    // routes through clearTerminalTabUnread (see pty-connection.ts and
    // TerminalPane.tsx); tab/group activation clears unreadTerminalTabs
    // directly in activateTab/focusGroup as a pre-existing side-effect.
    set((s) => {
      if (s.unreadTerminalTabs[tabId]) {
        return s
      }
      return { unreadTerminalTabs: { ...s.unreadTerminalTabs, [tabId]: true as const } }
    })
  },

  clearTerminalTabUnread: (tabId) => {
    set((s) => {
      if (!s.unreadTerminalTabs[tabId]) {
        return s
      }
      const copy = { ...s.unreadTerminalTabs }
      delete copy[tabId]
      return { unreadTerminalTabs: copy }
    })
  },

  setTabCustomTitle: (tabId, title) => {
    set((s) => {
      const next = { ...s.tabsByWorktree }
      for (const wId of Object.keys(next)) {
        next[wId] = next[wId].map((t) => (t.id === tabId ? { ...t, customTitle: title } : t))
      }
      scheduleRuntimeGraphSync()
      return { tabsByWorktree: next }
    })
    const item = Object.values(get().unifiedTabsByWorktree)
      .flat()
      .find((entry) => entry.contentType === 'terminal' && entry.entityId === tabId)
    if (item) {
      get().setTabCustomLabel(item.id, title)
    }
  },

  setTabColor: (tabId, color) => {
    set((s) => {
      const next = { ...s.tabsByWorktree }
      for (const wId of Object.keys(next)) {
        next[wId] = next[wId].map((t) => (t.id === tabId ? { ...t, color } : t))
      }
      return { tabsByWorktree: next }
    })
    const item = Object.values(get().unifiedTabsByWorktree)
      .flat()
      .find((entry) => entry.contentType === 'terminal' && entry.entityId === tabId)
    if (item) {
      get().setUnifiedTabColor(item.id, color)
    }
  },

  updateTabPtyId: (tabId, ptyId) => {
    let worktreeId: string | null = null
    let wasActivationSpawn = false
    set((s) => {
      const next = { ...s.tabsByWorktree }
      for (const wId of Object.keys(next)) {
        const found = next[wId].some((t) => t.id === tabId)
        if (found) {
          worktreeId = wId
        }
        next[wId] = next[wId].map((t) => {
          if (t.id !== tabId) {
            return t
          }
          const existingPtyIds = s.ptyIdsByTabId[tabId] ?? []
          const nextPtyIds = existingPtyIds.includes(ptyId)
            ? existingPtyIds
            : [...existingPtyIds, ptyId]
          if (t.pendingActivationSpawn) {
            wasActivationSpawn = true
          }
          // Why: consume pendingActivationSpawn here. The flag is set by
          // setActiveWorktree when it bumps generation on all-dead tabs, and
          // must be cleared on the first PTY that comes back or a later
          // legitimate respawn (e.g. the user restarting a codex tab) would
          // also be classified as activation and silently dropped from the
          // recency sort.
          const { pendingActivationSpawn: _unused, ...rest } = t
          void _unused
          return {
            ...rest,
            // Why: tab.ptyId is the single-pane fallback used by legacy attach
            // paths. In split panes, later pane spawns must not steal that
            // primary binding from the original pane or remount/close flows can
            // reattach the tab to the wrong PTY and appear to "reset" panes.
            ptyId: t.ptyId ?? nextPtyIds[0] ?? null
          }
        })
      }
      const existingPtyIds = s.ptyIdsByTabId[tabId] ?? []
      // Why: when a brand-new tab in the active worktree receives its first
      // PTY, the live-tab signal (+12) flips on. Normally we bump sortEpoch
      // here so the sort reflects the new signal immediately. Suppress the
      // bump on activation-driven spawns because they are side-effects of the
      // user clicking on a worktree, not real activity — otherwise clicking a
      // dormant worktree would always trigger a re-sort.
      const isFirstPty = existingPtyIds.length === 0
      const isActiveWorktree = worktreeId != null && s.activeWorktreeId === worktreeId
      const shouldBumpSortEpoch = isFirstPty && isActiveWorktree && !wasActivationSpawn
      return {
        tabsByWorktree: next,
        ptyIdsByTabId: {
          ...s.ptyIdsByTabId,
          [tabId]: existingPtyIds.includes(ptyId) ? existingPtyIds : [...existingPtyIds, ptyId]
        },
        lastKnownRelayPtyIdByTabId: {
          ...s.lastKnownRelayPtyIdByTabId,
          [tabId]: ptyId
        },
        ...(shouldBumpSortEpoch ? { sortEpoch: s.sortEpoch + 1 } : {})
      }
    })

    // Why: activation-driven spawns are caused by the user clicking a
    // worktree, not by work happening in it. Skip both the lastActivityAt
    // stamp and the sortEpoch bump so the sidebar does not reorder on click.
    // Other spawn reasons (new tab, codex restart, reconnect) still flow
    // through bumpWorktreeActivity as a normal activity signal.
    if (worktreeId && !wasActivationSpawn) {
      get().bumpWorktreeActivity(worktreeId)
    }
  },

  clearTabPtyId: (tabId, ptyId) => {
    let worktreeId: string | null = null
    let wasActivationSpawn = false
    set((s) => {
      const next = { ...s.tabsByWorktree }
      for (const wId of Object.keys(next)) {
        if (next[wId].some((t) => t.id === tabId)) {
          worktreeId = wId
        }
        next[wId] = next[wId].map((t) => {
          if (t.id !== tabId) {
            return t
          }
          if (t.pendingActivationSpawn) {
            wasActivationSpawn = true
          }
          const remainingPtyIds = ptyId
            ? (s.ptyIdsByTabId[tabId] ?? []).filter((id) => id !== ptyId)
            : []
          // Why: consume pendingActivationSpawn here too. Panes tearing down
          // during a worktree switch (e.g. the previously-active worktree
          // unmounting its panes) fire onExit → clearTabPtyId, which must
          // not count as activity. Strip the flag on consumption so later
          // legitimate exits still bump.
          const { pendingActivationSpawn: _unused, ...rest } = t
          void _unused
          return { ...rest, ptyId: remainingPtyIds.at(-1) ?? null }
        })
      }
      const nextPtyIdsByTabId = { ...s.ptyIdsByTabId }
      nextPtyIdsByTabId[tabId] = ptyId
        ? (nextPtyIdsByTabId[tabId] ?? []).filter((id) => id !== ptyId)
        : []
      const nextPendingCodexPaneRestartIds = { ...s.pendingCodexPaneRestartIds }
      const nextCodexRestartNoticeByPtyId = { ...s.codexRestartNoticeByPtyId }
      if (ptyId) {
        delete nextPendingCodexPaneRestartIds[ptyId]
        delete nextCodexRestartNoticeByPtyId[ptyId]
      } else {
        for (const currentPtyId of s.ptyIdsByTabId[tabId] ?? []) {
          delete nextPendingCodexPaneRestartIds[currentPtyId]
          delete nextCodexRestartNoticeByPtyId[currentPtyId]
        }
      }
      // Why: when a specific ptyId is passed, the PTY actually exited (not
      // just disconnected). Remove its lastKnown entry so session-save does
      // not attempt to reattach a dead relay PTY on next restart. When no
      // ptyId is passed (bulk clear on connection_lost), preserve lastKnown
      // because the relay still has the PTY alive during its grace period.
      const nextLastKnownRelay = { ...s.lastKnownRelayPtyIdByTabId }
      if (ptyId && nextLastKnownRelay[tabId] === ptyId) {
        delete nextLastKnownRelay[tabId]
      }

      return {
        tabsByWorktree: next,
        ptyIdsByTabId: nextPtyIdsByTabId,
        lastKnownRelayPtyIdByTabId: nextLastKnownRelay,
        pendingCodexPaneRestartIds: nextPendingCodexPaneRestartIds,
        codexRestartNoticeByPtyId: nextCodexRestartNoticeByPtyId
      }
    })

    // Bump meaningful activity when a PTY exits, but skip if this exit
    // was triggered by an intentional shutdown (suppressed exits) OR by a
    // click-driven pane unmount (pendingActivationSpawn).
    if (worktreeId && !wasActivationSpawn && !(ptyId && get().suppressedPtyExitIds[ptyId])) {
      get().bumpWorktreeActivity(worktreeId)
    }
  },

  shutdownWorktreeTerminals: async (worktreeId, opts) => {
    const keepIdentifiers = opts?.keepIdentifiers ?? false
    const tabs = get().tabsByWorktree[worktreeId] ?? []
    const ptyIds = tabs.flatMap((tab) => get().ptyIdsByTabId[tab.id] ?? [])

    // Why: the main process flushes any remaining batched PTY data before
    // sending the exit event (pty.ts onExit handler). Without this, that
    // final data burst flows through the still-registered ptyDataHandlers
    // where bell detection and agent-status tracking can fire system
    // notifications for a worktree that is already being torn down —
    // the "phantom alerts" users see after shutting down worktrees.
    // Removing the data handlers first ensures the final flush is a no-op.
    unregisterPtyDataHandlers(ptyIds)

    // Why (ordering invariant — DESIGN_DOC §3.3.c): on sleep, capture every
    // pane's serializer buffer into terminalLayoutsByTabId[tab].buffersByLeafId
    // BEFORE issuing pty.kill (panes unmount on PTY exit and their
    // serializeAddons go with them) AND BEFORE the set() block below (the
    // capture writes through to the store via its own setTabLayout call; any
    // subsequent set must use a functional updater spreading
    // s.terminalLayoutsByTabId, not a captured snapshot). For SSH this is
    // load-bearing — the relay drops the remote PTY on kill so there's no
    // on-disk history dir to cold-restore from. For local daemon it's
    // defense-in-depth alongside the on-disk history dir preserved by
    // keepHistory below.
    if (keepIdentifiers) {
      for (const tab of tabs) {
        const capture = shutdownBufferCaptures.get(tab.id)
        if (capture) {
          try {
            capture()
          } catch {
            // Don't let one tab's capture failure block the rest.
          }
        }
      }
    }

    set((s) => {
      const nextTabsByWorktree = keepIdentifiers
        ? s.tabsByWorktree
        : {
            ...s.tabsByWorktree,
            [worktreeId]: (s.tabsByWorktree[worktreeId] ?? []).map((tab, index) =>
              clearTransientTerminalState(tab, index)
            )
          }
      const nextPtyIdsByTabId = {
        ...s.ptyIdsByTabId,
        ...Object.fromEntries(tabs.map((tab) => [tab.id, [] as string[]] as const))
      }
      const nextRuntimePaneTitlesByTabId = keepIdentifiers
        ? s.runtimePaneTitlesByTabId
        : { ...s.runtimePaneTitlesByTabId }
      const nextSuppressedPtyExitIds = {
        ...s.suppressedPtyExitIds,
        ...Object.fromEntries(ptyIds.map((ptyId) => [ptyId, true] as const))
      }
      // Why: pendingCodexPaneRestartIds is keyed by ptyId — under sleep we
      // preserve it so a mid-restart marker survives wake against the same
      // identifier. codexRestartNoticeByPtyId is also keyed by the now-stale
      // ptyId; on wake the post-spawn ptyId may differ, so the notice can't
      // be carried forward and is cleared in both cases.
      const nextPendingCodexPaneRestartIds = keepIdentifiers
        ? s.pendingCodexPaneRestartIds
        : { ...s.pendingCodexPaneRestartIds }
      const nextCodexRestartNoticeByPtyId = { ...s.codexRestartNoticeByPtyId }
      for (const ptyId of ptyIds) {
        if (!keepIdentifiers) {
          delete nextPendingCodexPaneRestartIds[ptyId]
        }
        delete nextCodexRestartNoticeByPtyId[ptyId]
      }
      // Why: setup-split and issue-command-split are transient one-shots that
      // drive new-tab UX. They are not sleep-recovery state; clear in both
      // cases.
      const nextPendingSetupSplitByTabId = { ...s.pendingSetupSplitByTabId }
      const nextPendingIssueCommandSplitByTabId = { ...s.pendingIssueCommandSplitByTabId }
      // Why: under remove-worktree (default), layout snapshots carry
      // `ptyIdsByLeafId` referencing now-dead PTY IDs; if we leave them, the
      // next remount takes the reattach branch in connectPanePty and produces
      // a visible but non-interactive "zombie" pane. Under sleep
      // (keepIdentifiers), we preserve `ptyIdsByLeafId` precisely so wake can
      // pass them as args.sessionId to pty.spawn and reattach to the daemon
      // history dir (or, on SSH, restore scrollback from buffersByLeafId
      // captured above).
      const nextTerminalLayoutsByTabId = { ...s.terminalLayoutsByTabId }
      // Why: unread dots survive across worktree switches by design, but a
      // full shutdown tears down the PTYs behind them. Even under sleep, the
      // PTYs are killed, so unread state pointing at dead ptyIds is stale —
      // clear in both cases. (Carrying the dot across sleep would also be
      // surprising and inconsistent with how it behaves on tab close.)
      // Why: preserve the unreadTerminalTabs reference when none of the
      // shutting-down tabs had an unread flag — avoids a no-op top-level
      // state allocation that would force re-evaluation of full-state
      // selectors on unrelated shutdown calls. Mirrors the sibling pattern
      // in tabs.ts.
      let nextUnreadTerminalTabs = s.unreadTerminalTabs
      for (const tab of tabs) {
        if (!keepIdentifiers) {
          delete nextRuntimePaneTitlesByTabId[tab.id]
        }
        delete nextPendingSetupSplitByTabId[tab.id]
        delete nextPendingIssueCommandSplitByTabId[tab.id]
        if (nextUnreadTerminalTabs[tab.id]) {
          if (nextUnreadTerminalTabs === s.unreadTerminalTabs) {
            nextUnreadTerminalTabs = { ...s.unreadTerminalTabs }
          }
          delete nextUnreadTerminalTabs[tab.id]
        }
        if (!keepIdentifiers) {
          const existingLayout = nextTerminalLayoutsByTabId[tab.id]
          if (existingLayout?.ptyIdsByLeafId) {
            nextTerminalLayoutsByTabId[tab.id] = {
              ...existingLayout,
              ptyIdsByLeafId: {}
            }
          }
        }
      }

      // Why: under remove-worktree, intentional shutdown kills the relay PTY
      // and persisting a dead session ID would cause next-restart reattach to
      // fail. Under sleep, wake re-spawns over the relay against this exact
      // session ID — preserving it is what lets the wake-side wiring stay
      // consistent.
      const nextLastKnownRelay = keepIdentifiers
        ? s.lastKnownRelayPtyIdByTabId
        : { ...s.lastKnownRelayPtyIdByTabId }
      if (!keepIdentifiers) {
        for (const tab of tabs) {
          delete nextLastKnownRelay[tab.id]
        }
      }

      return {
        tabsByWorktree: nextTabsByWorktree,
        ptyIdsByTabId: nextPtyIdsByTabId,
        lastKnownRelayPtyIdByTabId: nextLastKnownRelay,
        runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId,
        suppressedPtyExitIds: nextSuppressedPtyExitIds,
        pendingCodexPaneRestartIds: nextPendingCodexPaneRestartIds,
        codexRestartNoticeByPtyId: nextCodexRestartNoticeByPtyId,
        pendingSetupSplitByTabId: nextPendingSetupSplitByTabId,
        pendingIssueCommandSplitByTabId: nextPendingIssueCommandSplitByTabId,
        terminalLayoutsByTabId: nextTerminalLayoutsByTabId,
        // Why: skip writing unreadTerminalTabs when the reference is unchanged —
        // avoids a no-op top-level state allocation that would force re-evaluation
        // of full-state selectors. Mirrors the sibling pattern in tabs.ts.
        ...(nextUnreadTerminalTabs !== s.unreadTerminalTabs
          ? { unreadTerminalTabs: nextUnreadTerminalTabs }
          : {})
      }
    })

    // Why: sleep/remove fold the whole worktree surface. The live PTY bindings
    // were cleared above and kill is about to run, so live rows are stale;
    // retained rows are folded too so a grey slept card does not keep a green
    // "done" row. Sweep by worktreeId because retained snapshots can outlive
    // their original tab.
    get().dropAgentStatusByWorktree(worktreeId)

    if (ptyIds.length === 0) {
      return
    }

    await Promise.allSettled(
      ptyIds.map((ptyId) => window.api.pty.kill(ptyId, { keepHistory: keepIdentifiers }))
    )
  },

  consumeSuppressedPtyExit: (ptyId) => {
    let wasSuppressed = false
    set((s) => {
      if (!s.suppressedPtyExitIds[ptyId]) {
        return {}
      }
      wasSuppressed = true
      const next = { ...s.suppressedPtyExitIds }
      delete next[ptyId]
      return { suppressedPtyExitIds: next }
    })
    return wasSuppressed
  },

  suppressPtyExit: (ptyId) => {
    set((s) => ({
      suppressedPtyExitIds: { ...s.suppressedPtyExitIds, [ptyId]: true }
    }))
  },

  queueCodexPaneRestarts: (ptyIds) => {
    if (ptyIds.length === 0) {
      return
    }
    set((s) => ({
      pendingCodexPaneRestartIds: {
        ...s.pendingCodexPaneRestartIds,
        ...Object.fromEntries(ptyIds.map((ptyId) => [ptyId, true] as const))
      }
    }))
  },

  consumePendingCodexPaneRestart: (ptyId) => {
    let wasQueued = false
    set((s) => {
      if (!s.pendingCodexPaneRestartIds[ptyId]) {
        return {}
      }
      wasQueued = true
      const next = { ...s.pendingCodexPaneRestartIds }
      delete next[ptyId]
      return { pendingCodexPaneRestartIds: next }
    })
    return wasQueued
  },

  markCodexRestartNotices: (notices) => {
    if (notices.length === 0) {
      return
    }
    set((s) => {
      const next = { ...s.codexRestartNoticeByPtyId }
      const nextPendingCodexPaneRestartIds = { ...s.pendingCodexPaneRestartIds }
      for (const notice of notices) {
        const existing = next[notice.ptyId]
        const previousAccountLabel = existing?.previousAccountLabel ?? notice.previousAccountLabel

        // Why: a live Codex pane stays on the account it originally launched
        // with until that pane actually restarts. Repeated account switches
        // must preserve that original pane account; otherwise A -> B -> A
        // keeps showing a stale restart notice even though the pane never left
        // account A and no longer needs a restart.
        if (previousAccountLabel === notice.nextAccountLabel) {
          delete next[notice.ptyId]
          delete nextPendingCodexPaneRestartIds[notice.ptyId]
          continue
        }

        next[notice.ptyId] = {
          previousAccountLabel,
          nextAccountLabel: notice.nextAccountLabel
        }
      }
      return {
        codexRestartNoticeByPtyId: next,
        pendingCodexPaneRestartIds: nextPendingCodexPaneRestartIds
      }
    })
  },

  clearCodexRestartNotice: (ptyId) => {
    set((s) => {
      if (!s.codexRestartNoticeByPtyId[ptyId]) {
        return {}
      }
      const next = { ...s.codexRestartNoticeByPtyId }
      const nextPendingCodexPaneRestartIds = { ...s.pendingCodexPaneRestartIds }
      delete next[ptyId]
      delete nextPendingCodexPaneRestartIds[ptyId]
      return {
        codexRestartNoticeByPtyId: next,
        pendingCodexPaneRestartIds: nextPendingCodexPaneRestartIds
      }
    })
  },

  setTabPaneExpanded: (tabId, expanded) => {
    set((s) => ({
      expandedPaneByTabId: { ...s.expandedPaneByTabId, [tabId]: expanded }
    }))
  },

  setTabCanExpandPane: (tabId, canExpand) => {
    set((s) => ({
      canExpandPaneByTabId: { ...s.canExpandPaneByTabId, [tabId]: canExpand }
    }))
  },

  setTabLayout: (tabId, layout) => {
    set((s) => {
      const next = { ...s.terminalLayoutsByTabId }
      if (layout) {
        next[tabId] = layout
      } else {
        delete next[tabId]
      }
      return { terminalLayoutsByTabId: next }
    })
  },

  queueTabStartupCommand: (tabId, startup) => {
    set((s) => ({
      pendingStartupByTabId: {
        ...s.pendingStartupByTabId,
        [tabId]: startup
      }
    }))
  },

  consumeTabStartupCommand: (tabId) => {
    const pending = get().pendingStartupByTabId[tabId]
    if (!pending) {
      return null
    }

    set((s) => {
      const next = { ...s.pendingStartupByTabId }
      delete next[tabId]
      return { pendingStartupByTabId: next }
    })

    return pending
  },

  queueTabSetupSplit: (tabId, startup) => {
    set((s) => ({
      pendingSetupSplitByTabId: {
        ...s.pendingSetupSplitByTabId,
        [tabId]: startup
      }
    }))
  },

  consumeTabSetupSplit: (tabId) => {
    const pending = get().pendingSetupSplitByTabId[tabId]
    if (!pending) {
      return null
    }

    set((s) => {
      const next = { ...s.pendingSetupSplitByTabId }
      delete next[tabId]
      return { pendingSetupSplitByTabId: next }
    })

    return pending
  },

  queueTabIssueCommandSplit: (tabId, issueCommand) => {
    set((s) => ({
      pendingIssueCommandSplitByTabId: {
        ...s.pendingIssueCommandSplitByTabId,
        [tabId]: issueCommand
      }
    }))
  },

  consumeTabIssueCommandSplit: (tabId) => {
    const pending = get().pendingIssueCommandSplitByTabId[tabId]
    if (!pending) {
      return null
    }

    set((s) => {
      const next = { ...s.pendingIssueCommandSplitByTabId }
      delete next[tabId]
      return { pendingIssueCommandSplitByTabId: next }
    })

    return pending
  },

  consumePendingSnapshot: (ptyId) => {
    const snapshot = get().pendingSnapshotByPtyId[ptyId]
    if (!snapshot) {
      return null
    }
    set((s) => {
      const next = { ...s.pendingSnapshotByPtyId }
      delete next[ptyId]
      return { pendingSnapshotByPtyId: next }
    })
    return snapshot
  },

  consumePendingColdRestore: (ptyId) => {
    const data = get().pendingColdRestoreByPtyId[ptyId]
    if (!data) {
      return null
    }
    set((s) => {
      const next = { ...s.pendingColdRestoreByPtyId }
      delete next[ptyId]
      return { pendingColdRestoreByPtyId: next }
    })
    return data
  },

  hydrateWorkspaceSession: (session) => {
    set((s) => {
      const validWorktreeIds = new Set(
        Object.values(s.worktreesByRepo)
          .flat()
          .map((worktree) => worktree.id)
      )
      // Why: SSH repos' worktrees are discovered at runtime via the relay, not
      // persisted in orca-data.json. On restart, worktreesByRepo for SSH repos
      // may still be empty when hydration runs (the SSH connection and worktree
      // fetch race with session hydration). Accept session worktree IDs whose
      // SSH-backed repo exists in the repos list — they will be populated once
      // SSH reconnects. Without this, tabs for SSH worktrees are silently
      // dropped during hydration and the session save overwrites the good data.
      // Only SSH repos need this: local worktrees are persisted and a missing
      // local worktree genuinely means it was deleted.
      const sshRepoIds = new Set(s.repos.filter((r) => r.connectionId).map((r) => r.id))
      for (const worktreeId of Object.keys(session.tabsByWorktree)) {
        if (!validWorktreeIds.has(worktreeId)) {
          const repoId = worktreeId.split('::')[0]
          if (sshRepoIds.has(repoId)) {
            validWorktreeIds.add(worktreeId)
          }
        }
      }
      // Why pendingActivationSpawn on hydrated tabs: when a worktree restored
      // from the previous session is mounted for the first time this session
      // (either because it's the restored activeWorktreeId, or because the
      // user clicks it), TerminalPane's connectPanePty fires — either
      // reattaching to the daemon/relay session or spawning fresh. Both call
      // updateTabPtyId, which would otherwise bump lastActivityAt and make
      // the worktree bounce to the top of Recent ~5 seconds later when an
      // unrelated event triggers a re-sort. Tagging at hydration covers the
      // restored-active worktree (which never goes through setActiveWorktree
      // again) and any other restored worktrees the user clicks later. The
      // tag is consumed on the first updateTabPtyId/clearTabPtyId per tab,
      // so subsequent legitimate events (codex restart, new pane) still bump.
      const tabsByWorktree: Record<string, TerminalTab[]> = Object.fromEntries(
        Object.entries(session.tabsByWorktree)
          .filter(([worktreeId]) => validWorktreeIds.has(worktreeId))
          .map(([worktreeId, tabs]) => [
            worktreeId,
            [...tabs]
              .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
              .map((tab, index) => ({
                ...clearTransientTerminalState(tab, index),
                sortOrder: index,
                pendingActivationSpawn: true
              }))
          ])
          .filter(([, tabs]) => tabs.length > 0)
      )

      const validTabIds = new Set(
        Object.values(tabsByWorktree)
          .flat()
          .map((tab) => tab.id)
      )
      const activeWorktreeId =
        session.activeWorktreeId && validWorktreeIds.has(session.activeWorktreeId)
          ? session.activeWorktreeId
          : null
      const activeTabId =
        session.activeTabId && validTabIds.has(session.activeTabId) ? session.activeTabId : null
      const activeRepoId =
        session.activeRepoId && s.repos.some((repo) => repo.id === session.activeRepoId)
          ? session.activeRepoId
          : null

      // Why: workspaceSessionReady stays false here. It is set to true in
      // reconnectPersistedTerminals() after all eager PTY spawns complete.
      // This prevents TerminalPane from mounting and spawning duplicate PTYs
      // before the reconnect phase has set ptyId on each tab.
      // Why: fall back to deriving the list from tabsByWorktree ptyIds when
      // activeWorktreeIdsOnShutdown is absent (upgrade from older build).
      // The raw tabs still carry ptyId values before clearTransientTerminalState
      // nulls them, so we can infer which worktrees had active terminals.
      const shutdownIds =
        session.activeWorktreeIdsOnShutdown ??
        Object.entries(session.tabsByWorktree)
          .filter(([, tabs]) => tabs.some((t) => t.ptyId))
          .map(([wId]) => wId)
      const pendingReconnectWorktreeIds = shutdownIds.filter((id) => validWorktreeIds.has(id))

      // Why: capture which specific tabs had live PTYs per worktree from the
      // raw session data BEFORE clearTransientTerminalState nulled the ptyIds.
      // This ensures reconnectPersistedTerminals binds PTYs to the correct
      // tabs, not just tabs[0], which matters for multi-tab worktrees.
      // Also include tabs whose relay session IDs were preserved in
      // remoteSessionIdsByTabId — those tabs were disconnected before shutdown
      // (ptyId was null) but the relay still has their PTY alive.
      const remoteSessionIds = session.remoteSessionIdsByTabId ?? {}
      const pendingReconnectTabByWorktree: Record<string, string[]> = {}
      for (const worktreeId of pendingReconnectWorktreeIds) {
        const rawTabs = session.tabsByWorktree[worktreeId] ?? []
        const liveTabIds = rawTabs
          .filter((t) => (t.ptyId || remoteSessionIds[t.id]) && validTabIds.has(t.id))
          .map((t) => t.id)
        if (liveTabIds.length > 0) {
          pendingReconnectTabByWorktree[worktreeId] = liveTabIds
        }
      }

      // Why: preserve the previous session's ptyId for each tab so that
      // reconnectPersistedTerminals can pass it as sessionId to the daemon's
      // createOrAttach RPC, triggering reattach instead of a fresh spawn.
      const pendingReconnectPtyIdByTabId: Record<string, string> = {}
      for (const worktreeId of pendingReconnectWorktreeIds) {
        const worktree = Object.values(s.worktreesByRepo)
          .flat()
          .find((entry) => entry.id === worktreeId)
        const repo = worktree ? s.repos.find((entry) => entry.id === worktree.repoId) : null
        if (repo?.connectionId) {
          continue
        }
        const rawTabs = session.tabsByWorktree[worktreeId] ?? []
        for (const tab of rawTabs) {
          if (tab.ptyId && validTabIds.has(tab.id)) {
            pendingReconnectPtyIdByTabId[tab.id] = tab.ptyId
          }
        }
      }

      // Why: remote PTY reattach uses the relay's pty.attach RPC, not the
      // local terminal daemon. The loop above correctly skips SSH repos
      // (connectionId check), so there is no overlap.
      console.warn(
        `[terminals-hydration] remoteSessionIdsByTabId:`,
        JSON.stringify(remoteSessionIds)
      )
      for (const [tabId, sessionId] of Object.entries(remoteSessionIds)) {
        if (validTabIds.has(tabId)) {
          pendingReconnectPtyIdByTabId[tabId] = sessionId
        }
      }

      // Why: restore per-worktree active terminal tab from session.
      // If the session has the map, validate that each tab ID still exists.
      // Otherwise, derive it: the active worktree gets activeTabId, others
      // default to their first tab.
      let activeTabIdByWorktree: Record<string, string | null> = {}
      if (session.activeTabIdByWorktree) {
        for (const [wId, tabId] of Object.entries(session.activeTabIdByWorktree)) {
          if (validWorktreeIds.has(wId) && tabId && validTabIds.has(tabId)) {
            activeTabIdByWorktree[wId] = tabId
          }
        }
      } else {
        // Legacy sessions: best-effort derivation
        if (activeWorktreeId && activeTabId) {
          activeTabIdByWorktree[activeWorktreeId] = activeTabId
        }
        for (const [wId, tabs] of Object.entries(tabsByWorktree)) {
          if (!activeTabIdByWorktree[wId] && tabs.length > 0) {
            activeTabIdByWorktree[wId] = tabs[0].id
          }
        }
      }

      // Why: SSH worktrees are not persisted in worktreesByRepo (they're
      // discovered at runtime via the relay). On restart, worktreesByRepo for
      // SSH repos is empty, so the sidebar can't render them. Synthesize
      // placeholder entries from the session's tabsByWorktree so the sidebar
      // shows them immediately. The placeholders will be replaced with full
      // data once SSH reconnects and fetchWorktrees runs.
      const worktreesByRepo = { ...s.worktreesByRepo }
      for (const worktreeId of Object.keys(tabsByWorktree)) {
        const repoId = worktreeId.split('::')[0]
        if (!sshRepoIds.has(repoId)) {
          continue
        }
        const existing = (worktreesByRepo[repoId] ?? []).find((w) => w.id === worktreeId)
        if (existing) {
          continue
        }
        // Why: worktreeId is `${repoId}::${path}` and POSIX paths can legally
        // contain `::`. Split only on the first separator to preserve the full path.
        const separatorIdx = worktreeId.indexOf('::')
        const path = separatorIdx >= 0 ? worktreeId.slice(separatorIdx + 2) : ''
        // Why: SSH worktree paths may use backslash separators on Windows remotes.
        const displayName = path.split(/[/\\]/).pop() || path
        const placeholder: Worktree = {
          id: worktreeId,
          repoId,
          displayName,
          comment: '',
          linkedIssue: null,
          linkedPR: null,
          linkedLinearIssue: null,
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          path,
          head: '',
          branch: '',
          isBare: false,
          isMainWorktree: false
        }
        worktreesByRepo[repoId] = [...(worktreesByRepo[repoId] ?? []), placeholder]
      }

      // Why: the restored-active worktree is set as activeWorktreeId here
      // without ever going through setActiveWorktree, so its first-activation
      // tagging needs to happen at hydration. Record it in
      // everActivatedWorktreeIds so a later re-click doesn't re-tag (which
      // would suppress real activity).
      const nextEverActivated = new Set(s.everActivatedWorktreeIds)
      if (activeWorktreeId) {
        nextEverActivated.add(activeWorktreeId)
      }

      return {
        activeRepoId,
        activeWorktreeId,
        activeTabId,
        activeTabIdByWorktree,
        tabsByWorktree,
        worktreesByRepo,
        // Why: restore the per-worktree focus-recency map. Pruning of stale
        // entries happens later (App.tsx calls pruneLastVisitedTimestamps
        // after hydration) — not here — because SSH worktrees may still be
        // appearing in worktreesByRepo at this moment.
        lastVisitedAtByWorktreeId: session.lastVisitedAtByWorktreeId ?? {},
        pendingReconnectWorktreeIds,
        pendingReconnectTabByWorktree,
        pendingReconnectPtyIdByTabId,
        everActivatedWorktreeIds: nextEverActivated,
        // Why: seed worktree nav history with the hydrated active worktree so
        // the first user-driven activation (e.g. a sidebar click to a different
        // worktree) has a prior entry to go Back to. Without this the restored
        // startup worktree is never recorded — recordWorktreeVisit only runs
        // inside activateAndRevealWorktree, which hydration bypasses — so Back
        // stays disabled until a second click produces the first-ever history
        // pair.
        worktreeNavHistory: activeWorktreeId ? [activeWorktreeId] : [],
        worktreeNavHistoryIndex: activeWorktreeId ? 0 : -1,
        ptyIdsByTabId: Object.fromEntries(
          Object.values(tabsByWorktree)
            .flat()
            .map((tab) => [tab.id, []] as const)
        ),
        // Why: with the daemon backend, ptyIds are daemon session IDs that
        // survive app restart. Preserve ptyIdsByLeafId so that
        // reconnectPersistedTerminals can reattach each split-pane leaf
        // to its specific daemon session (not just the tab-level ptyId).
        terminalLayoutsByTabId: Object.fromEntries(
          Object.entries(session.terminalLayoutsByTabId).filter(([tabId]) => validTabIds.has(tabId))
        )
      }
    })
  },

  reconnectPersistedTerminals: async (_signal) => {
    const {
      pendingReconnectWorktreeIds,
      pendingReconnectTabByWorktree,
      pendingReconnectPtyIdByTabId,
      terminalLayoutsByTabId,
      tabsByWorktree
    } = get()
    const ids = pendingReconnectWorktreeIds ?? []

    if (ids.length === 0) {
      set({
        workspaceSessionReady: true,
        pendingReconnectWorktreeIds: [],
        pendingReconnectTabByWorktree: {},
        pendingReconnectPtyIdByTabId: {}
      })
      return
    }

    // Why: instead of eagerly spawning PTYs at default 80×24 (which fills
    // eager buffers with content at wrong dimensions that gets garbled on
    // flush), we defer the actual daemon createOrAttach call to connectPanePty
    // where fitAddon provides real dims.
    //
    // This loop just records the daemon session IDs each leaf/tab needs so
    // connectPanePty can pass them as sessionId to pty.spawn at mount time.
    // The layout's ptyIdsByLeafId (preserved from shutdown) already has per-leaf
    // mappings. For single-pane tabs without leaf mappings, store the tab-level
    // ptyId as a sentinel so connectPanePty knows to reattach.
    ensurePtyDispatcher()

    for (const worktreeId of ids) {
      const tabs = tabsByWorktree[worktreeId] ?? []
      const worktree = Object.values(get().worktreesByRepo)
        .flat()
        .find((entry) => entry.id === worktreeId)
      const repo = worktree ? get().repos.find((entry) => entry.id === worktree.repoId) : null
      // Why: SSH-backed tabs were previously always skipped because the SSH
      // connection wasn't re-established on startup. Now that we auto-reconnect
      // SSH targets before this loop runs, we allow deferred reattach when the
      // SSH connection is active. Without the active-connection check, we'd try
      // to reattach to a relay that isn't connected yet (the deferred/passphrase
      // targets), which would fail.
      const sshState = repo?.connectionId ? get().sshConnectionStates.get(repo.connectionId) : null
      const sshConnected = repo?.connectionId != null && sshState?.status === 'connected'
      const supportsDeferredReattach = !repo?.connectionId || sshConnected
      console.warn(
        `[reconnect-terminals] worktree=${worktreeId} connectionId=${repo?.connectionId} sshStatus=${sshState?.status} supportsDeferredReattach=${supportsDeferredReattach}`
      )
      const targetTabIds = pendingReconnectTabByWorktree[worktreeId] ?? []
      const tabsToReconnect: TerminalTab[] =
        targetTabIds.length > 0
          ? targetTabIds
              .map((id) => tabs.find((t) => t.id === id))
              .filter((t): t is TerminalTab => t != null)
          : tabs.slice(0, 1)
      if (tabsToReconnect.length === 0) {
        continue
      }

      for (const tab of tabsToReconnect) {
        const tabId = tab.id
        const layout = terminalLayoutsByTabId[tabId]
        const leafPtyMap = layout?.ptyIdsByLeafId ?? {}
        const tabLevelPtyId = pendingReconnectPtyIdByTabId[tabId]
        const hasLeafMappings = Object.keys(leafPtyMap).length > 0

        // Why: populate the wake-hint and the live-pty map so the worktree
        // dot lights up green even before the terminal pane mounts —
        // including deferred SSH worktrees whose connection isn't established
        // yet. tab.ptyId carries the wake-hint sessionId (consumed by
        // pty-connection.ts on remount); ptyIdsByTabId is the source of
        // truth getWorktreeStatus reads for liveness. Without the live-pty
        // population, the sidebar "show active only" filter hides SSH
        // worktrees and the user must manually search for them. The actual
        // PTY reattach is handled later by pty-connection.ts when the
        // terminal pane mounts; this block only sets the visual state.
        console.warn(
          `[reconnect-terminals] tab=${tabId} tabLevelPtyId=${tabLevelPtyId} supportsDeferredReattach=${supportsDeferredReattach} hasLeafMappings=${hasLeafMappings}`
        )
        if (tabLevelPtyId) {
          set((s) => {
            const next = { ...s.tabsByWorktree }
            if (!next[worktreeId]) {
              return {}
            }
            next[worktreeId] = next[worktreeId].map((t) =>
              t.id === tabId ? { ...t, ptyId: tabLevelPtyId } : t
            )

            // Why: populate ptyIdsByTabId so the sessions status segment
            // can map daemon session IDs back to tabs (for bound/orphan
            // detection and click-to-navigate). Without this, all sessions
            // appear as orphans until the terminal pane mounts.
            const allPtyIds = hasLeafMappings
              ? (Object.values(leafPtyMap).filter(Boolean) as string[])
              : [tabLevelPtyId]
            return {
              tabsByWorktree: next,
              ptyIdsByTabId: {
                ...s.ptyIdsByTabId,
                [tabId]: allPtyIds
              }
            }
          })
        }
      }
    }

    // Why: deferred SSH targets (passphrase-protected) haven't connected
    // yet, so their tabs' ptyIds were never restored above. Stash the
    // session IDs in a separate map that survives this cleanup so the
    // deferred reconnect code in pty-connection.ts can find them.
    const deferredSshSessionIdsByTabId: Record<string, string> = {}
    for (const worktreeId of ids) {
      const worktree = Object.values(get().worktreesByRepo)
        .flat()
        .find((entry) => entry.id === worktreeId)
      const repo = worktree ? get().repos.find((entry) => entry.id === worktree.repoId) : null
      if (!repo?.connectionId) {
        continue
      }
      const sshConnected = get().sshConnectionStates.get(repo.connectionId)?.status === 'connected'
      if (sshConnected) {
        continue
      }
      const tabs = tabsByWorktree[worktreeId] ?? []
      for (const tab of tabs) {
        const sessionId = pendingReconnectPtyIdByTabId[tab.id]
        if (sessionId) {
          deferredSshSessionIdsByTabId[tab.id] = sessionId
        }
      }
    }

    set({
      workspaceSessionReady: true,
      pendingReconnectWorktreeIds: [],
      pendingReconnectTabByWorktree: {},
      pendingReconnectPtyIdByTabId: {},
      deferredSshSessionIdsByTabId
    })
  }
})
