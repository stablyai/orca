/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { BrowserLoadError, BrowserTab, WorkspaceSessionState } from '../../../../shared/types'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'

type CreateBrowserTabOptions = {
  activate?: boolean
  title?: string
}

type BrowserTabPageState = {
  title?: string
  loading?: boolean
  faviconUrl?: string | null
  canGoBack?: boolean
  canGoForward?: boolean
  loadError?: BrowserLoadError | null
}

export type BrowserSlice = {
  browserTabsByWorktree: Record<string, BrowserTab[]>
  activeBrowserTabId: string | null
  activeBrowserTabIdByWorktree: Record<string, string | null>
  pendingAddressBarFocusByTabId: Record<string, true>
  createBrowserTab: (
    worktreeId: string,
    url: string,
    options?: CreateBrowserTabOptions
  ) => BrowserTab
  closeBrowserTab: (tabId: string) => void
  setActiveBrowserTab: (tabId: string) => void
  consumeAddressBarFocusRequest: (tabId: string) => boolean
  updateBrowserTabPageState: (tabId: string, updates: BrowserTabPageState) => void
  setBrowserTabUrl: (tabId: string, url: string) => void
  hydrateBrowserSession: (session: WorkspaceSessionState) => void
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  if (trimmed.length === 0) {
    return 'about:blank'
  }
  return trimmed
}

function getFallbackTabTypeForWorktree(
  worktreeId: string,
  openFiles: AppState['openFiles'],
  terminalTabsByWorktree: AppState['tabsByWorktree'],
  browserTabsByWorktree?: AppState['browserTabsByWorktree']
): AppState['activeTabType'] {
  if (openFiles.some((file) => file.worktreeId === worktreeId)) {
    return 'editor'
  }
  if ((browserTabsByWorktree?.[worktreeId] ?? []).length > 0) {
    return 'browser'
  }
  if ((terminalTabsByWorktree[worktreeId] ?? []).length > 0) {
    return 'terminal'
  }
  return 'terminal'
}

export const createBrowserSlice: StateCreator<AppState, [], [], BrowserSlice> = (set, get) => ({
  browserTabsByWorktree: {},
  activeBrowserTabId: null,
  activeBrowserTabIdByWorktree: {},
  pendingAddressBarFocusByTabId: {},

  createBrowserTab: (worktreeId, url, options) => {
    const id = globalThis.crypto.randomUUID()
    const now = Date.now()
    const normalizedUrl = normalizeUrl(url)
    let browserTab!: BrowserTab
    set((s) => {
      const existingTabs = s.browserTabsByWorktree[worktreeId] ?? []
      browserTab = {
        id,
        worktreeId,
        url: normalizedUrl,
        title: options?.title ?? normalizedUrl,
        // Why: blank tabs mount a parked/inert guest surface first. Marking
        // them as loading at creation time makes every about:blank tab flash
        // the browser loading dot even when no navigation was requested.
        // Real navigations still flip loading via the browser pane events.
        loading: normalizedUrl !== 'about:blank' && normalizedUrl !== ORCA_BROWSER_BLANK_URL,
        faviconUrl: null,
        canGoBack: false,
        canGoForward: false,
        loadError: null,
        createdAt: now
      }

      const nextTabBarOrder = (() => {
        const currentOrder = s.tabBarOrderByWorktree[worktreeId] ?? []
        const terminalIds = (s.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
        const editorIds = s.openFiles
          .filter((file) => file.worktreeId === worktreeId)
          .map((f) => f.id)
        const browserIds = existingTabs.map((tab) => tab.id)
        const allExistingIds = new Set([...terminalIds, ...editorIds, ...browserIds])
        const base = currentOrder.filter((entryId) => allExistingIds.has(entryId))
        const inBase = new Set(base)
        for (const entryId of [...terminalIds, ...editorIds, ...browserIds]) {
          if (!inBase.has(entryId)) {
            base.push(entryId)
            inBase.add(entryId)
          }
        }
        base.push(id)
        return base
      })()

      const shouldActivate = options?.activate ?? true
      const shouldUpdateGlobalActiveSurface = shouldActivate && s.activeWorktreeId === worktreeId
      const shouldFocusAddressBar =
        shouldUpdateGlobalActiveSurface &&
        (normalizedUrl === 'about:blank' || normalizedUrl === ORCA_BROWSER_BLANK_URL)
      return {
        browserTabsByWorktree: {
          ...s.browserTabsByWorktree,
          [worktreeId]: [...existingTabs, browserTab]
        },
        tabBarOrderByWorktree: {
          ...s.tabBarOrderByWorktree,
          [worktreeId]: nextTabBarOrder
        },
        activeBrowserTabId: shouldActivate ? id : s.activeBrowserTabId,
        activeBrowserTabIdByWorktree: {
          ...s.activeBrowserTabIdByWorktree,
          [worktreeId]: shouldActivate ? id : (s.activeBrowserTabIdByWorktree[worktreeId] ?? null)
        },
        // Why: browser tabs live in the same visual strip as terminals and editors.
        // Creating one should immediately select the browser surface for that
        // worktree, but only the active worktree is allowed to drive Orca's
        // global visible surface. Background worktrees keep their per-worktree
        // browser selection without stealing the foreground pane.
        activeTabType: shouldUpdateGlobalActiveSurface ? 'browser' : s.activeTabType,
        activeTabTypeByWorktree: shouldActivate
          ? { ...s.activeTabTypeByWorktree, [worktreeId]: 'browser' }
          : s.activeTabTypeByWorktree,
        // Why: the active BrowserPane remounts on every browser-tab switch, so
        // a plain autoFocus would keep stealing focus whenever the user
        // revisits an existing tab. Queue a one-shot focus request only for a
        // freshly created blank tab, then let BrowserPane consume it once.
        pendingAddressBarFocusByTabId: shouldFocusAddressBar
          ? {
              ...s.pendingAddressBarFocusByTabId,
              [id]: true
            }
          : s.pendingAddressBarFocusByTabId
      }
    })
    // Why: wire browser tabs into the unified tab group system so they appear
    // in each group's tab bar and can live alongside terminals and editors,
    // matching the pattern terminals use (see createTab in terminals.ts).
    const state = get()
    const targetGroupId =
      state.activeGroupIdByWorktree[worktreeId] ?? state.groupsByWorktree[worktreeId]?.[0]?.id
    if (targetGroupId && !state.findTabForEntityInGroup(worktreeId, targetGroupId, id, 'browser')) {
      state.createUnifiedTab(worktreeId, 'browser', {
        entityId: id,
        label: options?.title ?? normalizedUrl
      })
    }
    return browserTab
  },

  closeBrowserTab: (tabId) => {
    set((s) => {
      let owningWorktreeId: string | null = null
      const nextBrowserTabsByWorktree: Record<string, BrowserTab[]> = {}
      for (const [worktreeId, tabs] of Object.entries(s.browserTabsByWorktree)) {
        const filtered = tabs.filter((tab) => tab.id !== tabId)
        if (filtered.length !== tabs.length) {
          owningWorktreeId = worktreeId
        }
        if (filtered.length > 0) {
          nextBrowserTabsByWorktree[worktreeId] = filtered
        }
      }
      if (!owningWorktreeId) {
        return s
      }

      const nextActiveBrowserTabIdByWorktree = { ...s.activeBrowserTabIdByWorktree }
      const remainingBrowserTabs = nextBrowserTabsByWorktree[owningWorktreeId] ?? []
      if (nextActiveBrowserTabIdByWorktree[owningWorktreeId] === tabId) {
        nextActiveBrowserTabIdByWorktree[owningWorktreeId] = remainingBrowserTabs[0]?.id ?? null
      }

      const nextTabBarOrder = {
        ...s.tabBarOrderByWorktree,
        [owningWorktreeId]: (s.tabBarOrderByWorktree[owningWorktreeId] ?? []).filter(
          (entryId) => entryId !== tabId
        )
      }

      const isActiveTabInOwningWorktree =
        s.activeWorktreeId === owningWorktreeId && s.activeBrowserTabId === tabId
      const nextActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
      let nextActiveTabType = s.activeTabType
      if (remainingBrowserTabs.length === 0) {
        const fallbackTabType = getFallbackTabTypeForWorktree(
          owningWorktreeId,
          s.openFiles,
          s.tabsByWorktree
        )
        nextActiveTabTypeByWorktree[owningWorktreeId] = fallbackTabType
        if (isActiveTabInOwningWorktree && s.activeTabType === 'browser') {
          // Why: the per-worktree restore map and the global active surface must
          // stay in lockstep. Leaving activeTabType at "browser" after the last
          // browser tab closes makes the workspace point at a surface that no
          // longer exists, which later renders as a blank body until another
          // caller repairs state opportunistically.
          nextActiveTabType = fallbackTabType
        }
      }
      return {
        browserTabsByWorktree: nextBrowserTabsByWorktree,
        activeBrowserTabId:
          s.activeBrowserTabId === tabId
            ? (remainingBrowserTabs[0]?.id ?? null)
            : s.activeBrowserTabId,
        activeBrowserTabIdByWorktree: nextActiveBrowserTabIdByWorktree,
        tabBarOrderByWorktree: nextTabBarOrder,
        activeTabType: nextActiveTabType,
        pendingAddressBarFocusByTabId: Object.fromEntries(
          Object.entries(s.pendingAddressBarFocusByTabId).filter(
            ([pendingTabId]) => pendingTabId !== tabId
          )
        ),
        activeTabTypeByWorktree: nextActiveTabTypeByWorktree
      }
    })
    // Why: sync browser tab closure with the unified tab group system so the
    // group removes the tab from its tab bar and collapses if empty.
    for (const tabs of Object.values(get().unifiedTabsByWorktree)) {
      const workspaceItem = tabs.find(
        (entry) => entry.contentType === 'browser' && entry.entityId === tabId
      )
      if (workspaceItem) {
        get().closeUnifiedTab(workspaceItem.id)
      }
    }
  },

  setActiveBrowserTab: (tabId) => {
    set((s) => {
      const browserTab = Object.values(s.browserTabsByWorktree)
        .flat()
        .find((tab) => tab.id === tabId)
      if (!browserTab) {
        return s
      }
      return {
        activeBrowserTabId: tabId,
        activeBrowserTabIdByWorktree: {
          ...s.activeBrowserTabIdByWorktree,
          [browserTab.worktreeId]: tabId
        },
        activeTabType: 'browser',
        activeTabTypeByWorktree: {
          ...s.activeTabTypeByWorktree,
          [browserTab.worktreeId]: 'browser'
        }
      }
    })
    // Sync with unified tab system — same pattern as setActiveTab in terminals.ts
    const item = Object.values(get().unifiedTabsByWorktree)
      .flat()
      .find((entry) => entry.contentType === 'browser' && entry.entityId === tabId)
    if (item) {
      get().activateTab(item.id)
    }
  },

  consumeAddressBarFocusRequest: (tabId) => {
    if (!get().pendingAddressBarFocusByTabId[tabId]) {
      return false
    }

    set((s) => {
      const next = { ...s.pendingAddressBarFocusByTabId }
      delete next[tabId]
      return { pendingAddressBarFocusByTabId: next }
    })

    return true
  },

  updateBrowserTabPageState: (tabId, updates) => {
    set((s) => ({
      browserTabsByWorktree: Object.fromEntries(
        Object.entries(s.browserTabsByWorktree).map(([worktreeId, tabs]) => [
          worktreeId,
          tabs.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  title: updates.title ?? tab.title,
                  loading: updates.loading ?? tab.loading,
                  faviconUrl:
                    updates.faviconUrl === undefined ? tab.faviconUrl : updates.faviconUrl,
                  canGoBack: updates.canGoBack ?? tab.canGoBack,
                  canGoForward: updates.canGoForward ?? tab.canGoForward,
                  loadError: updates.loadError === undefined ? tab.loadError : updates.loadError
                }
              : tab
          )
        ])
      )
    }))
    // Keep unified tab label in sync with browser page title
    if (updates.title) {
      const item = Object.values(get().unifiedTabsByWorktree)
        .flat()
        .find((entry) => entry.contentType === 'browser' && entry.entityId === tabId)
      if (item) {
        get().setTabLabel(item.id, updates.title)
      }
    }
  },

  setBrowserTabUrl: (tabId, url) =>
    set((s) => ({
      browserTabsByWorktree: Object.fromEntries(
        Object.entries(s.browserTabsByWorktree).map(([worktreeId, tabs]) => [
          worktreeId,
          tabs.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  url: normalizeUrl(url),
                  loading: true,
                  loadError: null
                }
              : tab
          )
        ])
      )
    })),

  hydrateBrowserSession: (session) => {
    set((s) => {
      const persistedTabsByWorktree = session.browserTabsByWorktree ?? {}
      const persistedActiveBrowserTabIdByWorktree = session.activeBrowserTabIdByWorktree ?? {}
      const persistedActiveTabTypeByWorktree = session.activeTabTypeByWorktree ?? {}
      const validWorktreeIds = new Set(
        Object.values(s.worktreesByRepo)
          .flat()
          .map((worktree) => worktree.id)
      )

      const browserTabsByWorktree: Record<string, BrowserTab[]> = Object.fromEntries(
        Object.entries(persistedTabsByWorktree)
          .filter(([worktreeId]) => validWorktreeIds.has(worktreeId))
          .map(([worktreeId, tabs]) => [
            worktreeId,
            tabs.map((tab) => ({
              ...tab,
              url: normalizeUrl(tab.url),
              loading: false,
              loadError: tab.loadError ?? null
            }))
          ])
          .filter(([, tabs]) => (tabs as BrowserTab[]).length > 0)
      )

      const validBrowserTabIds = new Set(
        Object.values(browserTabsByWorktree)
          .flat()
          .map((tab) => tab.id)
      )

      const activeBrowserTabIdByWorktree: Record<string, string | null> = {}
      for (const [worktreeId, tabs] of Object.entries(browserTabsByWorktree)) {
        const persistedTabId = persistedActiveBrowserTabIdByWorktree[worktreeId]
        activeBrowserTabIdByWorktree[worktreeId] =
          persistedTabId && validBrowserTabIds.has(persistedTabId)
            ? persistedTabId
            : (tabs[0]?.id ?? null)
      }

      const activeWorktreeId = s.activeWorktreeId
      const activeBrowserTabId =
        activeWorktreeId && activeBrowserTabIdByWorktree[activeWorktreeId]
          ? activeBrowserTabIdByWorktree[activeWorktreeId]
          : null

      // Why: hydrateEditorSession may have returned early (no editor files),
      // leaving activeTabTypeByWorktree as {}. We must merge in the 'browser'
      // entries from the persisted session, otherwise setActiveWorktree will
      // default to 'terminal' when switching to a worktree whose last-active
      // tab was a browser tab — causing a blank screen.
      const nextActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
      for (const worktreeId of validWorktreeIds) {
        const hasBrowserTabs = (browserTabsByWorktree[worktreeId] ?? []).length > 0
        if (
          persistedActiveTabTypeByWorktree[worktreeId] === 'browser' &&
          hasBrowserTabs &&
          !nextActiveTabTypeByWorktree[worktreeId]
        ) {
          // Why: browser hydration runs after editor hydration and owns only the
          // browser-visible restore path. Keep browser tab restores intact when
          // the persisted session still has a valid browser tab for that worktree.
          nextActiveTabTypeByWorktree[worktreeId] = 'browser'
          continue
        }
        if (nextActiveTabTypeByWorktree[worktreeId] === 'browser' && !hasBrowserTabs) {
          // Why: older/broken sessions can retain "browser" as the remembered
          // surface for a worktree after its browser tabs were closed. Leaving
          // that stale marker behind makes Terminal render the browser surface
          // with no matching tab, which looks like a blank app.
          nextActiveTabTypeByWorktree[worktreeId] = getFallbackTabTypeForWorktree(
            worktreeId,
            s.openFiles,
            s.tabsByWorktree,
            browserTabsByWorktree
          )
        }
      }

      const activeTabType = (() => {
        if (!activeWorktreeId) {
          return s.activeTabType
        }
        const restoredTabType = nextActiveTabTypeByWorktree[activeWorktreeId]
        if (restoredTabType === 'browser' && activeBrowserTabId) {
          return 'browser'
        }
        if (
          restoredTabType === 'editor' &&
          s.openFiles.some((file) => file.worktreeId === activeWorktreeId)
        ) {
          return 'editor'
        }
        return getFallbackTabTypeForWorktree(
          activeWorktreeId,
          s.openFiles,
          s.tabsByWorktree,
          browserTabsByWorktree
        )
      })()

      return {
        browserTabsByWorktree,
        activeBrowserTabIdByWorktree,
        activeBrowserTabId,
        activeTabTypeByWorktree: nextActiveTabTypeByWorktree,
        activeTabType
      }
    })
    // Why: sessions saved before browser tabs were integrated into the unified
    // tab group system won't have browser entries in unifiedTabs. Create them
    // now so existing browser tabs appear in group tab bars after upgrade.
    const state = get()
    for (const [worktreeId, browserTabs] of Object.entries(state.browserTabsByWorktree)) {
      for (const bt of browserTabs) {
        const exists = (state.unifiedTabsByWorktree[worktreeId] ?? []).some(
          (t) => t.contentType === 'browser' && t.entityId === bt.id
        )
        if (!exists) {
          state.createUnifiedTab(worktreeId, 'browser', {
            entityId: bt.id,
            label: bt.title
          })
        }
      }
    }
  }
})
