/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  TerminalLayoutSnapshot,
  TerminalTab,
  WorkspaceSessionState
} from '../../../../shared/types'
import { clearTransientTerminalState, emptyLayoutSnapshot } from './terminal-helpers'

export type TerminalSlice = {
  tabsByWorktree: Record<string, TerminalTab[]>
  activeTabId: string | null
  ptyIdsByTabId: Record<string, string[]>
  suppressedPtyExitIds: Record<string, true>
  expandedPaneByTabId: Record<string, boolean>
  canExpandPaneByTabId: Record<string, boolean>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  tabBarOrderByWorktree: Record<string, string[]>
  workspaceSessionReady: boolean
  createTab: (worktreeId: string) => TerminalTab
  closeTab: (tabId: string) => void
  reorderTabs: (worktreeId: string, tabIds: string[]) => void
  setTabBarOrder: (worktreeId: string, order: string[]) => void
  setActiveTab: (tabId: string) => void
  updateTabTitle: (tabId: string, title: string) => void
  setTabCustomTitle: (tabId: string, title: string | null) => void
  setTabColor: (tabId: string, color: string | null) => void
  updateTabPtyId: (tabId: string, ptyId: string) => void
  clearTabPtyId: (tabId: string, ptyId?: string) => void
  shutdownWorktreeTerminals: (worktreeId: string) => Promise<void>
  consumeSuppressedPtyExit: (ptyId: string) => boolean
  setTabPaneExpanded: (tabId: string, expanded: boolean) => void
  setTabCanExpandPane: (tabId: string, canExpand: boolean) => void
  setTabLayout: (tabId: string, layout: TerminalLayoutSnapshot | null) => void
  hydrateWorkspaceSession: (session: WorkspaceSessionState) => void
}

export const createTerminalSlice: StateCreator<AppState, [], [], TerminalSlice> = (set, get) => ({
  tabsByWorktree: {},
  activeTabId: null,
  ptyIdsByTabId: {},
  suppressedPtyExitIds: {},
  expandedPaneByTabId: {},
  canExpandPaneByTabId: {},
  terminalLayoutsByTabId: {},
  tabBarOrderByWorktree: {},
  workspaceSessionReady: false,

  createTab: (worktreeId) => {
    const id = globalThis.crypto.randomUUID()
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
        ptyIdsByTabId: { ...s.ptyIdsByTabId, [tab.id]: [] },
        terminalLayoutsByTabId: { ...s.terminalLayoutsByTabId, [tab.id]: emptyLayoutSnapshot() }
      }
    })
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
      return {
        tabsByWorktree: next,
        activeTabId: s.activeTabId === tabId ? null : s.activeTabId,
        ptyIdsByTabId: nextPtyIdsByTabId,
        expandedPaneByTabId: nextExpanded,
        canExpandPaneByTabId: nextCanExpand,
        terminalLayoutsByTabId: nextLayouts
      }
    })
  },

  reorderTabs: (worktreeId, tabIds) => {
    set((s) => {
      const tabs = s.tabsByWorktree[worktreeId] ?? []
      const tabMap = new Map(tabs.map((t) => [t.id, t]))
      const reordered = tabIds
        .map((id, i) => {
          const tab = tabMap.get(id)
          return tab ? { ...tab, sortOrder: i } : undefined
        })
        .filter((t): t is TerminalTab => t !== undefined)
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
      const updatedTabs = terminalIdsInOrder
        .map((id, i) => {
          const tab = tabMap.get(id)
          return tab ? { ...tab, sortOrder: i } : undefined
        })
        .filter((t): t is TerminalTab => t !== undefined)
      return {
        tabBarOrderByWorktree: newTabBarOrder,
        tabsByWorktree: { ...s.tabsByWorktree, [worktreeId]: updatedTabs }
      }
    })
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  updateTabTitle: (tabId, title) => {
    set((s) => {
      const next = { ...s.tabsByWorktree }
      for (const wId of Object.keys(next)) {
        next[wId] = next[wId].map((t) => (t.id === tabId ? { ...t, title } : t))
      }
      return { tabsByWorktree: next }
    })
  },

  setTabCustomTitle: (tabId, title) => {
    set((s) => {
      const next = { ...s.tabsByWorktree }
      for (const wId of Object.keys(next)) {
        next[wId] = next[wId].map((t) => (t.id === tabId ? { ...t, customTitle: title } : t))
      }
      return { tabsByWorktree: next }
    })
  },

  setTabColor: (tabId, color) => {
    set((s) => {
      const next = { ...s.tabsByWorktree }
      for (const wId of Object.keys(next)) {
        next[wId] = next[wId].map((t) => (t.id === tabId ? { ...t, color } : t))
      }
      return { tabsByWorktree: next }
    })
  },

  updateTabPtyId: (tabId, ptyId) => {
    set((s) => {
      const next = { ...s.tabsByWorktree }
      for (const wId of Object.keys(next)) {
        next[wId] = next[wId].map((t) => (t.id === tabId ? { ...t, ptyId } : t))
      }
      const existingPtyIds = s.ptyIdsByTabId[tabId] ?? []
      return {
        tabsByWorktree: next,
        ptyIdsByTabId: {
          ...s.ptyIdsByTabId,
          [tabId]: existingPtyIds.includes(ptyId) ? existingPtyIds : [...existingPtyIds, ptyId]
        }
      }
    })
  },

  clearTabPtyId: (tabId, ptyId) => {
    set((s) => {
      const next = { ...s.tabsByWorktree }
      for (const wId of Object.keys(next)) {
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
      return { tabsByWorktree: next, ptyIdsByTabId: nextPtyIdsByTabId }
    })
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
      const nextSuppressedPtyExitIds = {
        ...s.suppressedPtyExitIds,
        ...Object.fromEntries(ptyIds.map((ptyId) => [ptyId, true] as const))
      }

      return {
        tabsByWorktree: nextTabsByWorktree,
        ptyIdsByTabId: nextPtyIdsByTabId,
        suppressedPtyExitIds: nextSuppressedPtyExitIds
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

      return {
        activeRepoId,
        activeWorktreeId,
        activeTabId,
        tabsByWorktree,
        ptyIdsByTabId: Object.fromEntries(
          Object.values(tabsByWorktree)
            .flat()
            .map((tab) => [tab.id, []] as const)
        ),
        terminalLayoutsByTabId: Object.fromEntries(
          Object.entries(session.terminalLayoutsByTabId).filter(([tabId]) => validTabIds.has(tabId))
        ),
        workspaceSessionReady: true
      }
    })
  }
})
