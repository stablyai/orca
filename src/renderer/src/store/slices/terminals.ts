/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  SetupSplitDirection,
  TerminalLayoutSnapshot,
  TerminalTab,
  WorkspaceSessionState
} from '../../../../shared/types'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { clearTransientTerminalState, emptyLayoutSnapshot } from './terminal-helpers'
import { isClaudeAgent, detectAgentStatusFromTitle } from '@/lib/agent-status'
import { buildOrphanTerminalCleanupPatch, getOrphanTerminalIds } from './terminal-orphan-helpers'
import {
  ensurePtyDispatcher,
  unregisterPtyDataHandlers
} from '@/components/terminal-pane/pty-transport'

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
  createTab: (worktreeId: string, targetGroupId?: string) => TerminalTab
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
  pendingReconnectPtyIdByTabId: {},
  pendingSnapshotByPtyId: {},
  pendingColdRestoreByPtyId: {},
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

  createTab: (worktreeId, targetGroupId) => {
    const id = globalThis.crypto.randomUUID()
    let tab!: TerminalTab
    set((s) => {
      const orphanTerminalIds = getOrphanTerminalIds(s, worktreeId)
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
        createdAt: Date.now()
      }
      return {
        ...buildOrphanTerminalCleanupPatch(s, worktreeId, orphanTerminalIds),
        tabsByWorktree: {
          ...s.tabsByWorktree,
          [worktreeId]: [...existing, tab]
        },
        activeGroupIdByWorktree:
          targetGroupId &&
          s.groupsByWorktree[worktreeId]?.some((group) => group.id === targetGroupId)
            ? { ...s.activeGroupIdByWorktree, [worktreeId]: targetGroupId }
            : s.activeGroupIdByWorktree,
        activeTabId: tab.id,
        activeTabIdByWorktree: { ...s.activeTabIdByWorktree, [worktreeId]: tab.id },
        ptyIdsByTabId: { ...s.ptyIdsByTabId, [tab.id]: [] },
        terminalLayoutsByTabId: {
          ...s.terminalLayoutsByTabId,
          [tab.id]: emptyLayoutSnapshot()
        }
      }
    })
    const state = get()
    const resolvedTargetGroupId =
      targetGroupId ??
      state.activeGroupIdByWorktree[worktreeId] ??
      state.groupsByWorktree[worktreeId]?.[0]?.id ??
      state.ensureWorktreeRootGroup?.(worktreeId)
    if (
      resolvedTargetGroupId &&
      !state.findTabForEntityInGroup(worktreeId, resolvedTargetGroupId, id, 'terminal')
    ) {
      // Why: a brand-new worktree can auto-create its first terminal before
      // Terminal.tsx has mounted and seeded a root tab group. Force a root
      // group here so the first terminal always gets a visible unified tab
      // instead of existing only in the legacy terminal slice.
      state.createUnifiedTab(worktreeId, 'terminal', {
        id,
        entityId: id,
        label: tab.title,
        customLabel: tab.customTitle,
        color: tab.color,
        targetGroupId: resolvedTargetGroupId
      })
    }
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
        runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId,
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
    // Why: sweep live agent-status entries for this tab — the pane/tab state is
    // gone, so any remaining status would be stale. Delegate to the agent-status
    // slice so the epoch and stale-freshness timer bookkeeping stay consistent
    // with other agent-status mutations.
    //
    // Retained agent entries (retainedAgentsByPaneKey) are INTENTIONALLY NOT
    // swept here: they are worktree-scoped so a completed agent card survives
    // tab close, and are pruned separately by pruneRetainedAgents when the
    // worktree list refreshes, or by dismissRetainedAgentsByWorktree when the
    // worktree itself is deleted.
    get().removeAgentStatusByTabPrefix(tabId)
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

  updateTabTitle: (tabId, title) => {
    set((s) => {
      let changed = false
      let ownerWorktreeId: string | null = null
      const next = { ...s.tabsByWorktree }
      for (const wId of Object.keys(next)) {
        next[wId] = next[wId].map((t) => {
          if (t.id !== tabId) {
            return t
          }
          const nextTitle = title.trim() || getFallbackTabTitle(t)
          if (t.title === nextTitle) {
            return t
          }
          changed = true
          ownerWorktreeId = wId
          return {
            ...t,
            // Why: PTYs can briefly emit an empty title while an agent exits.
            // Keep the stable fallback label instead of rendering a blank tab.
            title: nextTitle,
            defaultTitle:
              t.defaultTitle ??
              (/^Terminal \d+$/.test(t.title) ? t.title : undefined) ??
              (/^Terminal \d+$/.test(nextTitle) ? nextTitle : undefined)
          }
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
        next[wId] = next[wId].map((t) => {
          if (t.id !== tabId) {
            return t
          }
          const existingPtyIds = s.ptyIdsByTabId[tabId] ?? []
          const nextPtyIds = existingPtyIds.includes(ptyId)
            ? existingPtyIds
            : [...existingPtyIds, ptyId]
          return {
            ...t,
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

    // Why: the main process flushes any remaining batched PTY data before
    // sending the exit event (pty.ts onExit handler). Without this, that
    // final data burst flows through the still-registered ptyDataHandlers
    // where bell detection and agent-status tracking can fire system
    // notifications for a worktree that is already being torn down —
    // the "phantom alerts" users see after shutting down worktrees.
    // Removing the data handlers first ensures the final flush is a no-op.
    unregisterPtyDataHandlers(ptyIds)

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
      // Why: layout snapshots carry `ptyIdsByLeafId` so in-session remounts
      // (e.g. tab-group moves) can reattach to live PTYs. After shutdown these
      // bindings point at killed PTY IDs; if we leave them, the next remount
      // takes the reattach branch in connectPanePty and produces a visible
      // but non-interactive "zombie" pane. Clearing the per-leaf binding
      // forces a fresh spawn when the user returns to the worktree.
      const nextTerminalLayoutsByTabId = { ...s.terminalLayoutsByTabId }
      for (const tab of tabs) {
        delete nextRuntimePaneTitlesByTabId[tab.id]
        delete nextPendingSetupSplitByTabId[tab.id]
        delete nextPendingIssueCommandSplitByTabId[tab.id]
        const existingLayout = nextTerminalLayoutsByTabId[tab.id]
        if (existingLayout?.ptyIdsByLeafId) {
          nextTerminalLayoutsByTabId[tab.id] = {
            ...existingLayout,
            ptyIdsByLeafId: {}
          }
        }
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
        terminalLayoutsByTabId: nextTerminalLayoutsByTabId,
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

      // Why: preserve the previous session's ptyId for each tab so that
      // reconnectPersistedTerminals can pass it as sessionId to the daemon's
      // createOrAttach RPC, triggering reattach instead of a fresh spawn.
      // When the experimental daemon is disabled, the LocalPtyProvider will
      // ignore any sessionId we pass anyway — populating this map just
      // persists stale daemon-era session IDs into the next session save,
      // which confuses debugging and bloats the session file. Skip it.
      const daemonEnabled = s.settings?.experimentalTerminalDaemon === true
      const pendingReconnectPtyIdByTabId: Record<string, string> = {}
      if (daemonEnabled) {
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
        pendingReconnectPtyIdByTabId,
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
      const supportsDeferredReattach = !repo?.connectionId
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

        // Why: restore ptyId on the tab so getWorktreeStatus() sees it as
        // active (green dot) even before the terminal pane mounts. For
        // single-pane tabs the tab-level ptyId doubles as the daemon
        // session ID. For split-pane tabs the layout's ptyIdsByLeafId
        // carries per-leaf mappings; connectPanePty reads those via
        // restoredPtyIdByLeafId, but the tab still needs a ptyId for
        // status and orphan detection.
        if (supportsDeferredReattach && tabLevelPtyId) {
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

    set({
      workspaceSessionReady: true,
      pendingReconnectWorktreeIds: [],
      pendingReconnectTabByWorktree: {},
      pendingReconnectPtyIdByTabId: {}
    })
  }
})
