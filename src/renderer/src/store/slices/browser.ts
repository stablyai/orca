/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { BrowserLoadError, BrowserTab, WorkspaceSessionState } from '../../../../shared/types'

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
  createBrowserTab: (
    worktreeId: string,
    url: string,
    options?: CreateBrowserTabOptions
  ) => BrowserTab
  closeBrowserTab: (tabId: string) => void
  setActiveBrowserTab: (tabId: string) => void
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

export const createBrowserSlice: StateCreator<AppState, [], [], BrowserSlice> = (set) => ({
  browserTabsByWorktree: {},
  activeBrowserTabId: null,
  activeBrowserTabIdByWorktree: {},

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
        loading: true,
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
        // Creating one should immediately select the browser surface for that worktree
        // instead of leaving focus on a different tab type behind the new tab label.
        activeTabType: shouldActivate ? 'browser' : s.activeTabType,
        activeTabTypeByWorktree: shouldActivate
          ? { ...s.activeTabTypeByWorktree, [worktreeId]: 'browser' }
          : s.activeTabTypeByWorktree
      }
    })
    return browserTab
  },

  closeBrowserTab: (tabId) =>
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
      const nextActiveTabType =
        isActiveTabInOwningWorktree &&
        remainingBrowserTabs.length === 0 &&
        s.openFiles.every((file) => file.worktreeId !== owningWorktreeId)
          ? 'terminal'
          : s.activeTabType

      const nextActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
      if (remainingBrowserTabs.length === 0) {
        nextActiveTabTypeByWorktree[owningWorktreeId] = getFallbackTabTypeForWorktree(
          owningWorktreeId,
          s.openFiles,
          s.tabsByWorktree
        )
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
        activeTabTypeByWorktree: nextActiveTabTypeByWorktree
      }
    }),

  setActiveBrowserTab: (tabId) =>
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
    }),

  updateBrowserTabPageState: (tabId, updates) =>
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
    })),

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

  hydrateBrowserSession: (session) =>
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
})
