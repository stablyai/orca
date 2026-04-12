/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  TerminalLayoutSnapshot,
  TerminalTab,
  WorkspaceSessionState
} from '../../../../shared/types'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { clearTransientTerminalState, emptyLayoutSnapshot } from './terminal-helpers'
import { isClaudeAgent, detectAgentStatusFromTitle } from '@/lib/agent-status'
import {
  registerEagerPtyBuffer,
  ensurePtyDispatcher
} from '@/components/terminal-pane/pty-transport'

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
  suppressedPtyExitIds: Record<string, true>
  pendingCodexPaneRestartIds: Record<string, true>
  codexRestartNoticeByPtyId: Record<
    string,
    { previousAccountLabel: string; nextAccountLabel: string }
  >
  expandedPaneByTabId: Record<string, boolean>
  canExpandPaneByTabId: Record<string, boolean>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  pendingStartupByTabId: Record<string, { command: string; env?: Record<string, string> }>
  /** Queued setup-split requests — when present, TerminalPane creates the
   *  initial pane clean, then splits right and runs the command in the new pane
   *  so the main terminal stays immediately interactive. */
  pendingSetupSplitByTabId: Record<string, { command: string; env?: Record<string, string> }>
  /** Queued issue-command-split requests — similar to setup splits but triggered
   *  when an issue is linked during worktree creation and the repo's issue
   *  automation command is enabled. */
  pendingIssueCommandSplitByTabId: Record<string, { command: string; env?: Record<string, string> }>
  tabBarOrderByWorktree: Record<string, string[]>
  workspaceSessionReady: boolean
  pendingReconnectWorktreeIds: string[]
  pendingReconnectTabByWorktree: Record<string, string[]>
  createTab: (worktreeId: string, tabId?: string) => TerminalTab
  closeTab: (tabId: string) => void
  reorderTabs: (worktreeId: string, tabIds: string[]) => void
  setTabBarOrder: (worktreeId: string, order: string[]) => void
  setActiveTab: (tabId: string) => void
  updateTabTitle: (tabId: string, title: string) => void
  setRuntimePaneTitle: (tabId: string, paneId: number, title: string) => void
  clearRuntimePaneTitle: (tabId: string, paneId: number) => void
  setTabCustomTitle: (tabId: string, title: string | null) => void
  setTabColor: (tabId: string, color: string | null) => void
  updateTabPtyId: (tabId: string, ptyId: string) => void
  clearTabPtyId: (tabId: string, ptyId?: string) => void
  shutdownWorktreeTerminals: (worktreeId: string) => Promise<void>
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
    startup: { command: string; env?: Record<string, string> }
  ) => void
  consumeTabStartupCommand: (
    tabId: string
  ) => { command: string; env?: Record<string, string> } | null
  queueTabSetupSplit: (
    tabId: string,
    startup: { command: string; env?: Record<string, string> }
  ) => void
  consumeTabSetupSplit: (tabId: string) => { command: string; env?: Record<string, string> } | null
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
  hydrateWorkspaceSession: (session: WorkspaceSessionState) => void
  reconnectPersistedTerminals: (signal?: AbortSignal) => Promise<void>
}

export const createTerminalSlice: StateCreator<AppState, [], [], TerminalSlice> = (set, get) => ({
  tabsByWorktree: {},
  activeTabId: null,
  activeTabIdByWorktree: {},
  ptyIdsByTabId: {},
  runtimePaneTitlesByTabId: {},
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

  createTab: (worktreeId, tabId) => {
    const id = tabId ?? globalThis.crypto.randomUUID()
    let tab!: TerminalTab
    set((s) => {
      const existing = s.tabsByWorktree[worktreeId] ?? []
      tab = {
        id,
        ptyId: null,
        worktreeId,
        title: `Terminal ${existing.length + 1}`,
        customTitle: null,
        color: null,
        sortOrder: existing.length,
        createdAt: Date.now()
      }
      return {
        tabsByWorktree: {
          ...s.tabsByWorktree,
          [worktreeId]: [...existing, tab]
        },
        activeTabId: tab.id,
        activeTabIdByWorktree: { ...s.activeTabIdByWorktree, [worktreeId]: tab.id },
        ptyIdsByTabId: { ...s.ptyIdsByTabId, [tab.id]: [] },
        terminalLayoutsByTabId: { ...s.terminalLayoutsByTabId, [tab.id]: emptyLayoutSnapshot() }
      }
    })
    const state = get()
    const targetGroupId =
      state.activeGroupIdByWorktree[worktreeId] ?? state.groupsByWorktree[worktreeId]?.[0]?.id
    if (
      targetGroupId &&
      !state.findTabForEntityInGroup(worktreeId, targetGroupId, id, 'terminal')
    ) {
      state.createUnifiedTab(worktreeId, 'terminal', {
        id,
        entityId: id,
        label: tab.title,
        customLabel: tab.customTitle,
        color: tab.color
      })
    } else if (targetGroupId) {
      state.activateTab(id)
    }
    return tab
  },

  closeTab: (tabId) => {
    set((s) => {
      const next = { ...s.tabsByWorktree }
      for (const wId of Object.keys(next)) {
        const before = next[wId]
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
      const nextRuntimePaneTitlesByTabId = { ...s.runtimePaneTitlesByTabId }
      delete nextRuntimePaneTitlesByTabId[tabId]
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

      return {
        tabsByWorktree: next,
        activeTabId: s.activeTabId === tabId ? null : s.activeTabId,
        activeTabIdByWorktree: nextActiveTabIdByWorktree,
        ptyIdsByTabId: nextPtyIdsByTabId,
        runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId,
        expandedPaneByTabId: nextExpanded,
        canExpandPaneByTabId: nextCanExpand,
        terminalLayoutsByTabId: nextLayouts,
        pendingStartupByTabId: nextPendingStartupByTabId,
        pendingSetupSplitByTabId: nextPendingSetupSplitByTabId,
        pendingIssueCommandSplitByTabId: nextPendingIssueCommandSplitByTabId,
        cacheTimerByKey: nextCacheTimer
      }
    })
    const item = get().unifiedTabsByWorktree
    for (const tabs of Object.values(item)) {
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
      const worktreeId = s.activeWorktreeId
      return {
        activeTabId: tabId,
        activeTabIdByWorktree: worktreeId
          ? { ...s.activeTabIdByWorktree, [worktreeId]: tabId }
          : s.activeTabIdByWorktree
      }
    })
    const item = Object.values(get().unifiedTabsByWorktree)
      .flat()
      .find((entry) => entry.contentType === 'terminal' && entry.entityId === tabId)
    if (item) {
      get().activateTab(item.id)
    }
  },

  // Keep the canonical workspace item label in sync with terminal runtime title.

  updateTabTitle: (tabId, title) => {
    set((s) => {
      let changed = false
      let ownerWorktreeId: string | null = null
      const next = { ...s.tabsByWorktree }
      for (const wId of Object.keys(next)) {
        next[wId] = next[wId].map((t) => {
          if (t.id !== tabId || t.title === title) {
            return t
          }
          changed = true
          ownerWorktreeId = wId
          return { ...t, title }
        })
      }
      if (!changed) {
        return s
      }
      scheduleRuntimeGraphSync()
      // Agent status is derived from terminal titles and affects sort scoring,
      // so a title change is a meaningful event that should allow re-sort —
      // but only for background worktrees. Title changes in the active
      // worktree are side-effects of PTY reconnection during worktree
      // activation (generation bump → TerminalPane remount → new shell →
      // title update). Bumping sortEpoch here would reorder the sidebar
      // on click — the exact bug PR #209 intended to fix.
      const isActive = ownerWorktreeId === s.activeWorktreeId
      return isActive
        ? { tabsByWorktree: next }
        : { tabsByWorktree: next, sortEpoch: s.sortEpoch + 1 }
    })
    const item = Object.values(get().unifiedTabsByWorktree)
      .flat()
      .find((entry) => entry.contentType === 'terminal' && entry.entityId === tabId)
    if (item) {
      get().setTabLabel(item.id, title)
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
    set((s) => {
      const next = { ...s.tabsByWorktree }
      for (const wId of Object.keys(next)) {
        const found = next[wId].some((t) => t.id === tabId)
        if (found) {
          worktreeId = wId
        }
        next[wId] = next[wId].map((t) => (t.id === tabId ? { ...t, ptyId } : t))
      }
      const existingPtyIds = s.ptyIdsByTabId[tabId] ?? []
      // Why: when a brand-new tab in the active worktree receives its first
      // PTY, the live-tab signal (+12) flips on. bumpWorktreeActivity (below)
      // intentionally skips sortEpoch for the active worktree to prevent the
      // reorder-on-click bug (PR #209), but that means the sort never sees
      // the new signal. Bump sortEpoch here so a just-created worktree
      // immediately reflects its live-tab score instead of waiting for an
      // unrelated event to trigger a re-sort.
      const isFirstPty = existingPtyIds.length === 0
      const isActiveWorktree = worktreeId != null && s.activeWorktreeId === worktreeId
      return {
        tabsByWorktree: next,
        ptyIdsByTabId: {
          ...s.ptyIdsByTabId,
          [tabId]: existingPtyIds.includes(ptyId) ? existingPtyIds : [...existingPtyIds, ptyId]
        },
        ...(isFirstPty && isActiveWorktree ? { sortEpoch: s.sortEpoch + 1 } : {})
      }
    })

    // Bump meaningful activity when a PTY spawns
    if (worktreeId) {
      get().bumpWorktreeActivity(worktreeId)
    }
  },

  clearTabPtyId: (tabId, ptyId) => {
    let worktreeId: string | null = null
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
          const remainingPtyIds = ptyId
            ? (s.ptyIdsByTabId[tabId] ?? []).filter((id) => id !== ptyId)
            : []
          return { ...t, ptyId: remainingPtyIds.at(-1) ?? null }
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
      return {
        tabsByWorktree: next,
        ptyIdsByTabId: nextPtyIdsByTabId,
        pendingCodexPaneRestartIds: nextPendingCodexPaneRestartIds,
        codexRestartNoticeByPtyId: nextCodexRestartNoticeByPtyId
      }
    })

    // Bump meaningful activity when a PTY exits, but skip if this exit
    // was triggered by an intentional shutdown (suppressed exits).
    if (worktreeId && !(ptyId && get().suppressedPtyExitIds[ptyId])) {
      get().bumpWorktreeActivity(worktreeId)
    }
  },

  shutdownWorktreeTerminals: async (worktreeId) => {
    const tabs = get().tabsByWorktree[worktreeId] ?? []
    const ptyIds = tabs.flatMap((tab) => get().ptyIdsByTabId[tab.id] ?? [])

    set((s) => {
      const nextTabsByWorktree = {
        ...s.tabsByWorktree,
        [worktreeId]: (s.tabsByWorktree[worktreeId] ?? []).map((tab, index) =>
          clearTransientTerminalState(tab, index)
        )
      }
      const nextPtyIdsByTabId = {
        ...s.ptyIdsByTabId,
        ...Object.fromEntries(tabs.map((tab) => [tab.id, [] as string[]] as const))
      }
      const nextRuntimePaneTitlesByTabId = { ...s.runtimePaneTitlesByTabId }
      const nextSuppressedPtyExitIds = {
        ...s.suppressedPtyExitIds,
        ...Object.fromEntries(ptyIds.map((ptyId) => [ptyId, true] as const))
      }
      const nextPendingCodexPaneRestartIds = { ...s.pendingCodexPaneRestartIds }
      const nextCodexRestartNoticeByPtyId = { ...s.codexRestartNoticeByPtyId }
      for (const ptyId of ptyIds) {
        delete nextPendingCodexPaneRestartIds[ptyId]
        delete nextCodexRestartNoticeByPtyId[ptyId]
      }
      // Why: clear any queued setup and issue-command splits for the affected
      // tabs so stale commands do not fire unintended splits when the worktree
      // is later remounted.
      const nextPendingSetupSplitByTabId = { ...s.pendingSetupSplitByTabId }
      const nextPendingIssueCommandSplitByTabId = { ...s.pendingIssueCommandSplitByTabId }
      for (const tab of tabs) {
        delete nextRuntimePaneTitlesByTabId[tab.id]
        delete nextPendingSetupSplitByTabId[tab.id]
        delete nextPendingIssueCommandSplitByTabId[tab.id]
      }

      // Why: browser tabs are factored into getWorktreeStatus — leaving them
      // behind after shutdown keeps the sidebar dot green even though all
      // terminals are dead.  Clearing them here ensures the status indicator
      // transitions to inactive.
      const nextBrowserTabsByWorktree = { ...s.browserTabsByWorktree }
      const hadBrowserTabs = (nextBrowserTabsByWorktree[worktreeId] ?? []).length > 0
      delete nextBrowserTabsByWorktree[worktreeId]
      const nextActiveBrowserTabIdByWorktree = { ...s.activeBrowserTabIdByWorktree }
      delete nextActiveBrowserTabIdByWorktree[worktreeId]

      // Why: when shutting down the active worktree, the global
      // activeBrowserTabId and activeTabType may still point at a browser
      // surface that no longer exists.  Reset them so the workspace does not
      // render a blank browser pane.  Background worktrees do not own the
      // global surface, so we leave them untouched.
      const isActiveWorktree = s.activeWorktreeId === worktreeId
      const shouldResetGlobalBrowser = isActiveWorktree && hadBrowserTabs

      return {
        tabsByWorktree: nextTabsByWorktree,
        ptyIdsByTabId: nextPtyIdsByTabId,
        runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId,
        suppressedPtyExitIds: nextSuppressedPtyExitIds,
        pendingCodexPaneRestartIds: nextPendingCodexPaneRestartIds,
        codexRestartNoticeByPtyId: nextCodexRestartNoticeByPtyId,
        pendingSetupSplitByTabId: nextPendingSetupSplitByTabId,
        pendingIssueCommandSplitByTabId: nextPendingIssueCommandSplitByTabId,
        browserTabsByWorktree: nextBrowserTabsByWorktree,
        activeBrowserTabIdByWorktree: nextActiveBrowserTabIdByWorktree,
        ...(shouldResetGlobalBrowser
          ? { activeBrowserTabId: null, activeTabType: 'terminal' as const }
          : {})
      }
    })

    if (ptyIds.length === 0) {
      return
    }

    await Promise.allSettled(ptyIds.map((ptyId) => window.api.pty.kill(ptyId)))
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

  hydrateWorkspaceSession: (session) => {
    set((s) => {
      const validWorktreeIds = new Set(
        Object.values(s.worktreesByRepo)
          .flat()
          .map((worktree) => worktree.id)
      )
      const tabsByWorktree: Record<string, TerminalTab[]> = Object.fromEntries(
        Object.entries(session.tabsByWorktree)
          .filter(([worktreeId]) => validWorktreeIds.has(worktreeId))
          .map(([worktreeId, tabs]) => [
            worktreeId,
            [...tabs]
              .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
              .map((tab, index) => ({
                ...clearTransientTerminalState(tab, index),
                sortOrder: index
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
      const pendingReconnectTabByWorktree: Record<string, string[]> = {}
      for (const worktreeId of pendingReconnectWorktreeIds) {
        const rawTabs = session.tabsByWorktree[worktreeId] ?? []
        const liveTabIds = rawTabs.filter((t) => t.ptyId && validTabIds.has(t.id)).map((t) => t.id)
        if (liveTabIds.length > 0) {
          pendingReconnectTabByWorktree[worktreeId] = liveTabIds
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

      return {
        activeRepoId,
        activeWorktreeId,
        activeTabId,
        activeTabIdByWorktree,
        tabsByWorktree,
        pendingReconnectWorktreeIds,
        pendingReconnectTabByWorktree,
        ptyIdsByTabId: Object.fromEntries(
          Object.values(tabsByWorktree)
            .flat()
            .map((tab) => [tab.id, []] as const)
        ),
        terminalLayoutsByTabId: Object.fromEntries(
          Object.entries(session.terminalLayoutsByTabId).filter(([tabId]) => validTabIds.has(tabId))
        )
      }
    })
  },

  reconnectPersistedTerminals: async (signal) => {
    const {
      pendingReconnectWorktreeIds,
      pendingReconnectTabByWorktree,
      worktreesByRepo,
      tabsByWorktree
    } = get()
    const ids = pendingReconnectWorktreeIds ?? []

    if (ids.length === 0) {
      set({
        workspaceSessionReady: true,
        pendingReconnectWorktreeIds: [],
        pendingReconnectTabByWorktree: {}
      })
      return
    }

    const allWorktrees = Object.values(worktreesByRepo).flat()
    const worktreeMap = new Map(allWorktrees.map((w) => [w.id, w]))
    const spawnedPtyIds: string[] = []

    // Why: ensure the global IPC listener for pty:data/pty:exit events is
    // active before any spawn calls. This guarantees that data emitted
    // immediately after spawn (before registerEagerPtyBuffer runs) is at
    // least delivered to the dispatcher — and since registerEagerPtyBuffer
    // runs synchronously in the microtask continuation after await spawn(),
    // the handler will be in place before any macrotask-queued data arrives.
    ensurePtyDispatcher()

    for (const worktreeId of ids) {
      if (signal?.aborted) {
        // StrictMode unmount — kill any PTYs we already spawned and bail.
        await Promise.allSettled(spawnedPtyIds.map((id) => window.api.pty.kill(id)))
        return
      }

      const worktree = worktreeMap.get(worktreeId)
      if (!worktree) {
        continue
      }

      const tabs = tabsByWorktree[worktreeId] ?? []
      // Why: pendingReconnectTabByWorktree was computed during hydration from
      // the raw session data (before ptyIds were cleared). It tells us exactly
      // which tabs had live PTYs in each worktree, so we reconnect all of them
      // rather than just one arbitrary tab.
      const targetTabIds = pendingReconnectTabByWorktree[worktreeId] ?? []
      const tabsToReconnect: TerminalTab[] =
        targetTabIds.length > 0
          ? targetTabIds
              .map((id) => tabs.find((t) => t.id === id))
              .filter((t): t is TerminalTab => t != null)
          : tabs.slice(0, 1) // fallback: first tab only
      if (tabsToReconnect.length === 0) {
        continue
      }

      for (const tab of tabsToReconnect) {
        if (signal?.aborted) {
          await Promise.allSettled(spawnedPtyIds.map((id) => window.api.pty.kill(id)))
          return
        }

        try {
          const { id: ptyId } = await window.api.pty.spawn({
            cols: 80,
            rows: 24,
            cwd: worktree.path
          })
          spawnedPtyIds.push(ptyId)

          if (signal?.aborted) {
            await window.api.pty.kill(ptyId)
            await Promise.allSettled(
              spawnedPtyIds.filter((id) => id !== ptyId).map((id) => window.api.pty.kill(id))
            )
            return
          }

          const tabId = tab.id
          // Why: re-check that the tab/worktree still exist after the async
          // spawn. If the user deleted the worktree during the spawn round-
          // trip, kill the orphan PTY immediately instead of registering it.
          const currentTabs = get().tabsByWorktree[worktreeId]
          if (!currentTabs?.some((t) => t.id === tabId)) {
            void window.api.pty.kill(ptyId)
            continue
          }

          // Why: register exit handler so that if the shell dies before
          // TerminalPane attaches, the tab's ptyId is cleared and
          // connectPanePty falls through to the normal connect() path.
          registerEagerPtyBuffer(ptyId, (_exitedPtyId, _code) => {
            get().clearTabPtyId(tabId, _exitedPtyId)
          })

          // Why: set ptyId directly instead of using updateTabPtyId to avoid
          // bumpWorktreeActivity which would overwrite every reconnected
          // worktree's lastActivityAt with the restart timestamp, destroying
          // the relative recency sort order.
          set((s) => {
            const next = { ...s.tabsByWorktree }
            if (!next[worktreeId]) {
              return {}
            }
            next[worktreeId] = next[worktreeId].map((t) => (t.id === tabId ? { ...t, ptyId } : t))
            return {
              tabsByWorktree: next,
              ptyIdsByTabId: {
                ...s.ptyIdsByTabId,
                [tabId]: [...(s.ptyIdsByTabId[tabId] ?? []), ptyId]
              }
            }
          })
        } catch {
          // PTY spawn failure — this tab stays inactive, same as today.
        }
      }
    }

    set({
      workspaceSessionReady: true,
      pendingReconnectWorktreeIds: [],
      pendingReconnectTabByWorktree: {}
    })
  }
})
