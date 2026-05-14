/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  BrowserCookieImportResult,
  BrowserCookieImportSummary,
  BrowserHistoryEntry,
  BrowserLoadError,
  BrowserPage,
  BrowserSessionProfile,
  BrowserViewportPresetId,
  BrowserWorkspace,
  WorkspaceSessionState
} from '../../../../shared/types'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'
import { redactKagiSessionToken } from '../../../../shared/browser-url'
import {
  MAX_BROWSER_HISTORY_ENTRIES,
  normalizeBrowserHistoryEntries,
  normalizeBrowserHistoryUrl
} from '../../../../shared/workspace-session-browser-history'
import { pickNeighbor } from './tab-group-state'
import { destroyWorkspaceWebviews } from './browser-webview-cleanup'

type CreateBrowserTabOptions = {
  activate?: boolean
  title?: string
  sessionProfileId?: string | null
  // Why: callers like "Open Preview to the Side" need to place the new browser
  // tab in a specific (sibling or newly-split) group rather than the ambient
  // active group. Defaults to the worktree's current active group.
  targetGroupId?: string
  // Why: the explicit "New Tab" action (keyboard shortcut, + button) should
  // land the user in the address bar even when their configured home page is a
  // real URL, so they can type a destination immediately. Link-opened tabs
  // (context menu, window.open, http link routing) leave this unset so focus
  // stays on the webview. When omitted, we fall back to the blank-URL check.
  focusAddressBar?: boolean
}

type CreateBrowserPageOptions = {
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

type ClosedBrowserWorkspaceSnapshot = {
  workspace: BrowserWorkspace
  pages: BrowserPage[]
}

export type BrowserSlice = {
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>
  browserPagesByWorkspace: Record<string, BrowserPage[]>
  activeBrowserTabId: string | null
  activeBrowserTabIdByWorktree: Record<string, string | null>
  recentlyClosedBrowserTabsByWorktree: Record<string, ClosedBrowserWorkspaceSnapshot[]>
  recentlyClosedBrowserPagesByWorkspace: Record<string, BrowserPage[]>
  pendingAddressBarFocusByTabId: Record<string, true>
  pendingAddressBarFocusByPageId: Record<string, true>
  createBrowserTab: (
    worktreeId: string,
    url: string,
    options?: CreateBrowserTabOptions
  ) => BrowserWorkspace
  closeBrowserTab: (tabId: string) => void
  shutdownWorktreeBrowsers: (worktreeId: string) => Promise<void>
  reopenClosedBrowserTab: (worktreeId: string) => BrowserWorkspace | null
  setActiveBrowserTab: (tabId: string) => void
  createBrowserPage: (
    workspaceId: string,
    url: string,
    options?: CreateBrowserPageOptions
  ) => BrowserPage | null
  closeBrowserPage: (pageId: string) => void
  reopenClosedBrowserPage: (workspaceId: string) => BrowserPage | null
  setActiveBrowserPage: (workspaceId: string, pageId: string) => void
  // Why: scoped sibling of setActiveBrowserTab+setActiveBrowserPage that
  // never yanks the user across worktrees. Multiple agents can drive
  // browsers in parallel worktrees; a global focus call from agent X would
  // steal the screen from the user reading agent Y. Updates per-worktree
  // active tab/page unconditionally; updates the GLOBAL active tab and (if
  // surfacePane) global activeTabType only when worktreeId === active
  // worktree. Cross-worktree calls pre-stage the targeted worktree's view
  // for whenever the user next switches to it.
  focusBrowserTabInWorktree: (
    worktreeId: string,
    browserPageId: string,
    options?: { surfacePane?: boolean }
  ) => void
  consumeAddressBarFocusRequest: (pageId: string) => boolean
  updateBrowserTabPageState: (pageId: string, updates: BrowserTabPageState) => void
  updateBrowserPageState: (pageId: string, updates: BrowserTabPageState) => void
  setBrowserTabUrl: (pageId: string, url: string) => void
  setBrowserPageUrl: (pageId: string, url: string) => void
  setBrowserPageViewportPreset: (
    pageId: string,
    viewportPresetId: BrowserViewportPresetId | null
  ) => void
  hydrateBrowserSession: (session: WorkspaceSessionState) => void
  switchBrowserTabProfile: (workspaceId: string, profileId: string | null) => void
  browserSessionProfiles: BrowserSessionProfile[]
  browserSessionImportState: {
    profileId: string
    status: 'idle' | 'importing' | 'success' | 'error'
    summary: BrowserCookieImportSummary | null
    error: string | null
  } | null
  fetchBrowserSessionProfiles: () => Promise<void>
  createBrowserSessionProfile: (
    scope: 'isolated' | 'imported',
    label: string
  ) => Promise<BrowserSessionProfile | null>
  deleteBrowserSessionProfile: (profileId: string) => Promise<boolean>
  importCookiesToProfile: (profileId: string) => Promise<BrowserCookieImportResult>
  clearBrowserSessionImportState: () => void
  detectedBrowsers: {
    family: string
    label: string
    profiles: { name: string; directory: string }[]
    selectedProfile: string
  }[]
  detectedBrowsersLoaded: boolean
  fetchDetectedBrowsers: () => Promise<void>
  importCookiesFromBrowser: (
    profileId: string,
    browserFamily: string,
    browserProfile?: string
  ) => Promise<BrowserCookieImportResult>
  clearDefaultSessionCookies: () => Promise<boolean>
  browserUrlHistory: BrowserHistoryEntry[]
  addBrowserHistoryEntry: (url: string, title: string) => void
  clearBrowserHistory: () => void
  defaultBrowserSessionProfileId: string | null
  setDefaultBrowserSessionProfileId: (profileId: string | null) => void
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  if (trimmed.length === 0) {
    return 'about:blank'
  }
  // Why: setBrowserPageUrl is the single sink for URL updates from did-navigate,
  // CDP navigation-update IPC, and direct address-bar submits. Redact at this
  // boundary so the Kagi bearer token cannot reach BrowserPage.url, which is
  // persisted to disk via the workspace session writer.
  return redactKagiSessionToken(trimmed)
}

function normalizeBrowserTitle(title: string | null | undefined, url: string): string {
  if (
    url === 'about:blank' ||
    url === ORCA_BROWSER_BLANK_URL ||
    title === 'about:blank' ||
    title === ORCA_BROWSER_BLANK_URL ||
    !title
  ) {
    // Why: blank pages render through Orca's inert data: URL guest. Persisting
    // that internal bootstrap URL as the page/workspace title leaks an
    // implementation detail into the tab strip and makes every blank page look
    // broken. Keep the user-facing label stable as "New Tab" instead.
    return 'New Tab'
  }
  return title
}

function buildBrowserPage(
  workspaceId: string,
  worktreeId: string,
  url: string,
  title?: string
): BrowserPage {
  const normalizedUrl = normalizeUrl(url)
  return {
    id: globalThis.crypto.randomUUID(),
    workspaceId,
    worktreeId,
    url: normalizedUrl,
    title: normalizeBrowserTitle(title, normalizedUrl),
    // Why: blank pages mount an inert guest first. Treating them as loading
    // would make an empty workspace flash the global loading affordance even
    // though no real navigation happened yet.
    loading: normalizedUrl !== 'about:blank' && normalizedUrl !== ORCA_BROWSER_BLANK_URL,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: Date.now()
  }
}

function buildWorkspaceFromPage(
  id: string,
  worktreeId: string,
  page: BrowserPage,
  pageIds: string[],
  sessionProfileId?: string | null
): BrowserWorkspace {
  return {
    id,
    worktreeId,
    sessionProfileId: sessionProfileId ?? null,
    activePageId: page.id,
    pageIds,
    url: page.url,
    title: page.title,
    loading: page.loading,
    faviconUrl: page.faviconUrl,
    canGoBack: page.canGoBack,
    canGoForward: page.canGoForward,
    loadError: page.loadError,
    createdAt: page.createdAt
  }
}

function mirrorWorkspaceFromActivePage(
  workspace: BrowserWorkspace,
  pages: BrowserPage[]
): BrowserWorkspace {
  const activePage = pages.find((page) => page.id === workspace.activePageId) ?? null
  if (!activePage) {
    return {
      ...workspace,
      activePageId: null,
      pageIds: pages.map((page) => page.id),
      url: 'about:blank',
      title: 'Browser',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null
    }
  }
  return {
    ...workspace,
    activePageId: activePage.id,
    pageIds: pages.map((page) => page.id),
    url: activePage.url,
    title: activePage.title,
    loading: activePage.loading,
    faviconUrl: activePage.faviconUrl,
    canGoBack: activePage.canGoBack,
    canGoForward: activePage.canGoForward,
    loadError: activePage.loadError
  }
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

function findWorkspace(
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>,
  workspaceId: string
): BrowserWorkspace | null {
  return (
    Object.values(browserTabsByWorktree)
      .flat()
      .find((workspace) => workspace.id === workspaceId) ?? null
  )
}

function findPage(
  browserPagesByWorkspace: Record<string, BrowserPage[]>,
  pageId: string
): BrowserPage | null {
  return (
    Object.values(browserPagesByWorkspace)
      .flat()
      .find((page) => page.id === pageId) ?? null
  )
}

export const createBrowserSlice: StateCreator<AppState, [], [], BrowserSlice> = (set, get) => ({
  browserTabsByWorktree: {},
  browserPagesByWorkspace: {},
  activeBrowserTabId: null,
  activeBrowserTabIdByWorktree: {},
  recentlyClosedBrowserTabsByWorktree: {},
  recentlyClosedBrowserPagesByWorkspace: {},
  pendingAddressBarFocusByTabId: {},
  pendingAddressBarFocusByPageId: {},
  browserSessionProfiles: [],
  browserSessionImportState: null,
  browserUrlHistory: [],
  defaultBrowserSessionProfileId: null,

  setDefaultBrowserSessionProfileId: (profileId) => {
    set({ defaultBrowserSessionProfileId: profileId })
  },

  createBrowserTab: (worktreeId, url, options) => {
    const workspaceId = globalThis.crypto.randomUUID()
    const page = buildBrowserPage(workspaceId, worktreeId, url, options?.title)
    // Why: when no explicit profile is passed, inherit the user's chosen default
    // profile. This lets users set a preferred profile in Settings that all new
    // browser tabs use automatically.
    const sessionProfileId =
      options?.sessionProfileId !== undefined
        ? options.sessionProfileId
        : get().defaultBrowserSessionProfileId
    const browserTab = buildWorkspaceFromPage(
      workspaceId,
      worktreeId,
      page,
      [page.id],
      sessionProfileId
    )

    set((s) => {
      const existingTabs = s.browserTabsByWorktree[worktreeId] ?? []
      const nextTabBarOrder = (() => {
        const currentOrder = s.tabBarOrderByWorktree[worktreeId] ?? []
        const terminalIds = (s.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
        const editorIds = s.openFiles
          .filter((file) => file.worktreeId === worktreeId)
          .map((file) => file.id)
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
        base.push(workspaceId)
        return base
      })()

      const shouldActivate = options?.activate ?? true
      const shouldUpdateGlobalActiveSurface = shouldActivate && s.activeWorktreeId === worktreeId
      const shouldFocusAddressBar =
        shouldUpdateGlobalActiveSurface &&
        (options?.focusAddressBar ??
          (page.url === 'about:blank' || page.url === ORCA_BROWSER_BLANK_URL))

      return {
        browserTabsByWorktree: {
          ...s.browserTabsByWorktree,
          [worktreeId]: [...existingTabs, browserTab]
        },
        browserPagesByWorkspace: {
          ...s.browserPagesByWorkspace,
          [workspaceId]: [page]
        },
        tabBarOrderByWorktree: {
          ...s.tabBarOrderByWorktree,
          [worktreeId]: nextTabBarOrder
        },
        activeBrowserTabId: shouldActivate ? workspaceId : s.activeBrowserTabId,
        activeBrowserTabIdByWorktree: {
          ...s.activeBrowserTabIdByWorktree,
          [worktreeId]: shouldActivate
            ? workspaceId
            : (s.activeBrowserTabIdByWorktree[worktreeId] ?? null)
        },
        activeTabType: shouldUpdateGlobalActiveSurface ? 'browser' : s.activeTabType,
        activeTabTypeByWorktree: shouldActivate
          ? { ...s.activeTabTypeByWorktree, [worktreeId]: 'browser' }
          : s.activeTabTypeByWorktree,
        pendingAddressBarFocusByPageId: shouldFocusAddressBar
          ? {
              ...s.pendingAddressBarFocusByPageId,
              [page.id]: true
            }
          : s.pendingAddressBarFocusByPageId,
        pendingAddressBarFocusByTabId: shouldFocusAddressBar
          ? {
              ...s.pendingAddressBarFocusByTabId,
              [workspaceId]: true,
              [page.id]: true
            }
          : s.pendingAddressBarFocusByTabId
      }
    })

    const state = get()
    const alreadyHasUnifiedTab = (state.unifiedTabsByWorktree[worktreeId] ?? []).some(
      (t) => t.contentType === 'browser' && t.entityId === workspaceId
    )
    if (!alreadyHasUnifiedTab) {
      state.createUnifiedTab(worktreeId, 'browser', {
        entityId: workspaceId,
        label: browserTab.title,
        targetGroupId: options?.targetGroupId
      })
    }
    return browserTab
  },

  closeBrowserTab: (tabId) => {
    set((s) => {
      let owningWorktreeId: string | null = null
      let closedWorkspace: BrowserWorkspace | null = null
      const nextBrowserTabsByWorktree: Record<string, BrowserWorkspace[]> = {}
      for (const [worktreeId, tabs] of Object.entries(s.browserTabsByWorktree)) {
        const removedTab = tabs.find((tab) => tab.id === tabId) ?? null
        const filtered = tabs.filter((tab) => tab.id !== tabId)
        if (filtered.length !== tabs.length) {
          owningWorktreeId = worktreeId
          closedWorkspace = removedTab
        }
        if (filtered.length > 0) {
          nextBrowserTabsByWorktree[worktreeId] = filtered
        }
      }
      if (!owningWorktreeId || !closedWorkspace) {
        return s
      }

      const closedPages = s.browserPagesByWorkspace[tabId] ?? []
      const nextBrowserPagesByWorkspace = { ...s.browserPagesByWorkspace }
      delete nextBrowserPagesByWorkspace[tabId]

      const nextActiveBrowserTabIdByWorktree = { ...s.activeBrowserTabIdByWorktree }
      const remainingBrowserTabs = nextBrowserTabsByWorktree[owningWorktreeId] ?? []
      const tabBarOrder = s.tabBarOrderByWorktree[owningWorktreeId] ?? []
      const neighborTabId = pickNeighbor(tabBarOrder, tabId)
      if (nextActiveBrowserTabIdByWorktree[owningWorktreeId] === tabId) {
        nextActiveBrowserTabIdByWorktree[owningWorktreeId] =
          neighborTabId ?? remainingBrowserTabs[0]?.id ?? null
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
          nextActiveTabType = fallbackTabType
        }
      }

      const nextRecentlyClosedBrowserTabsByWorktree = { ...s.recentlyClosedBrowserTabsByWorktree }
      const existingSnapshots = nextRecentlyClosedBrowserTabsByWorktree[owningWorktreeId] ?? []
      nextRecentlyClosedBrowserTabsByWorktree[owningWorktreeId] = [
        { workspace: closedWorkspace, pages: closedPages },
        ...existingSnapshots.filter((entry) => entry.workspace.id !== closedWorkspace.id)
      ].slice(0, 10)

      const nextRecentlyClosedBrowserPagesByWorkspace = {
        ...s.recentlyClosedBrowserPagesByWorkspace
      }
      delete nextRecentlyClosedBrowserPagesByWorkspace[tabId]

      const nextPendingAddressBarFocusByPageId = Object.fromEntries(
        Object.entries(s.pendingAddressBarFocusByPageId).filter(
          ([pageId]) => !closedPages.some((page) => page.id === pageId)
        )
      )
      const nextPendingAddressBarFocusByTabId = Object.fromEntries(
        Object.entries(s.pendingAddressBarFocusByTabId).filter(
          ([focusId]) => focusId !== tabId && !closedPages.some((page) => page.id === focusId)
        )
      )

      return {
        browserTabsByWorktree: nextBrowserTabsByWorktree,
        browserPagesByWorkspace: nextBrowserPagesByWorkspace,
        activeBrowserTabId:
          s.activeBrowserTabId === tabId
            ? (neighborTabId ?? remainingBrowserTabs[0]?.id ?? null)
            : s.activeBrowserTabId,
        activeBrowserTabIdByWorktree: nextActiveBrowserTabIdByWorktree,
        tabBarOrderByWorktree: nextTabBarOrder,
        activeTabType: nextActiveTabType,
        pendingAddressBarFocusByPageId: nextPendingAddressBarFocusByPageId,
        pendingAddressBarFocusByTabId: nextPendingAddressBarFocusByTabId,
        activeTabTypeByWorktree: nextActiveTabTypeByWorktree,
        recentlyClosedBrowserTabsByWorktree: nextRecentlyClosedBrowserTabsByWorktree,
        recentlyClosedBrowserPagesByWorkspace: nextRecentlyClosedBrowserPagesByWorkspace
      }
    })

    for (const tabs of Object.values(get().unifiedTabsByWorktree)) {
      const workspaceItem = tabs.find(
        (entry) => entry.contentType === 'browser' && entry.entityId === tabId
      )
      if (workspaceItem) {
        get().closeUnifiedTab(workspaceItem.id)
      }
    }
  },

  shutdownWorktreeBrowsers: async (worktreeId) => {
    const workspaces = get().browserTabsByWorktree[worktreeId] ?? []
    // Why: snapshot pre-loop so the post-loop set() can reproduce the original
    // `hadBrowserTabs` semantics. Reading `s.browserTabsByWorktree[worktreeId]`
    // inside set() would always be empty here because each closeBrowserTab call
    // above has already removed the workspace from that array.
    const hadBrowserTabs = workspaces.length > 0
    for (const workspace of workspaces) {
      destroyWorkspaceWebviews(get().browserPagesByWorkspace, workspace.id)
      get().closeBrowserTab(workspace.id)
    }
    set((s) => {
      const nextBrowserTabsByWorktree = { ...s.browserTabsByWorktree }
      delete nextBrowserTabsByWorktree[worktreeId]
      const nextActiveBrowserTabIdByWorktree = { ...s.activeBrowserTabIdByWorktree }
      delete nextActiveBrowserTabIdByWorktree[worktreeId]
      // Why: mirror shutdownWorktreeTerminals' `hadBrowserTabs && isActive`
      // guard. Only reset the globally-visible active browser surface when the
      // worktree being shut down is the one the user is looking at AND it
      // actually had browser tabs to tear down.
      const shouldResetGlobalBrowser = s.activeWorktreeId === worktreeId && hadBrowserTabs
      return {
        browserTabsByWorktree: nextBrowserTabsByWorktree,
        activeBrowserTabIdByWorktree: nextActiveBrowserTabIdByWorktree,
        ...(shouldResetGlobalBrowser
          ? { activeBrowserTabId: null, activeTabType: 'terminal' as const }
          : {})
      }
    })
  },

  reopenClosedBrowserTab: (worktreeId) => {
    // Why: read and pop atomically inside set() to prevent a TOCTOU race
    // where two rapid Cmd+Shift+T presses both restore the same entry.
    let entryToRestore: ClosedBrowserWorkspaceSnapshot | undefined

    set((s) => {
      const recentlyClosed = s.recentlyClosedBrowserTabsByWorktree[worktreeId] ?? []
      entryToRestore = recentlyClosed[0]
      if (!entryToRestore) {
        return s
      }
      return {
        recentlyClosedBrowserTabsByWorktree: {
          ...s.recentlyClosedBrowserTabsByWorktree,
          [worktreeId]: recentlyClosed.slice(1)
        }
      }
    })

    if (!entryToRestore) {
      return null
    }

    const snap = entryToRestore.workspace
    const pages = entryToRestore.pages
    const sessionProfileId = snap.sessionProfileId ?? null

    if (pages.length === 0) {
      const restored = get().createBrowserTab(worktreeId, snap.url, {
        title: snap.title,
        activate: true,
        sessionProfileId
      })
      return get().browserTabsByWorktree[worktreeId]?.find((tab) => tab.id === restored.id) ?? null
    }

    // Why: create the tab with the first page, then append the rest in
    // original order so multi-page workspaces preserve their page sequence.
    const [firstPage, ...restPages] = pages
    const restored = get().createBrowserTab(worktreeId, firstPage.url, {
      title: firstPage.title,
      activate: true,
      sessionProfileId
    })

    for (const p of restPages) {
      get().createBrowserPage(restored.id, p.url, {
        activate: false,
        title: p.title
      })
    }

    // Activate the originally-active page if it wasn't the first one
    const activePageId = snap.activePageId
    if (activePageId) {
      const restoredPages = get().browserPagesByWorkspace[restored.id] ?? []
      const targetPage = restoredPages.find(
        (p) => p.url === pages.find((orig) => orig.id === activePageId)?.url
      )
      if (targetPage && targetPage.id !== restoredPages[0]?.id) {
        get().setActiveBrowserPage(restored.id, targetPage.id)
      }
    }

    return get().browserTabsByWorktree[worktreeId]?.find((tab) => tab.id === restored.id) ?? null
  },

  setActiveBrowserTab: (tabId) => {
    set((s) => {
      const browserTab = findWorkspace(s.browserTabsByWorktree, tabId)
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

    // Why: notify the CDP bridge which guest webContents is now active so
    // subsequent agent commands (snapshot, click, etc.) target the correct tab.
    // registerGuest uses page IDs (not workspace IDs), so we resolve the active
    // page within the workspace to find the correct browserPageId.
    const workspace = findWorkspace(get().browserTabsByWorktree, tabId)
    if (workspace?.activePageId && typeof window !== 'undefined' && window.api?.browser) {
      window.api.browser
        .notifyActiveTabChanged({ browserPageId: workspace.activePageId })
        .catch(() => {})
    }

    const item = Object.values(get().unifiedTabsByWorktree)
      .flat()
      .find((entry) => entry.contentType === 'browser' && entry.entityId === tabId)
    if (item) {
      get().activateTab(item.id)
    }
  },

  createBrowserPage: (workspaceId, url, options) => {
    const workspace = findWorkspace(get().browserTabsByWorktree, workspaceId)
    if (!workspace) {
      return null
    }
    const page = buildBrowserPage(workspaceId, workspace.worktreeId, url, options?.title)

    set((s) => {
      const pages = s.browserPagesByWorkspace[workspaceId] ?? []
      const shouldActivate = options?.activate ?? true
      const nextPages = [...pages, page]
      const nextWorkspace = mirrorWorkspaceFromActivePage(
        {
          ...workspace,
          activePageId: shouldActivate ? page.id : (workspace.activePageId ?? page.id),
          pageIds: nextPages.map((entry) => entry.id)
        },
        nextPages
      )
      const shouldUpdateGlobalActiveSurface =
        shouldActivate &&
        s.activeWorktreeId === workspace.worktreeId &&
        s.activeBrowserTabIdByWorktree[workspace.worktreeId] === workspaceId
      const shouldFocusAddressBar =
        shouldUpdateGlobalActiveSurface &&
        (page.url === 'about:blank' || page.url === ORCA_BROWSER_BLANK_URL)

      return {
        browserPagesByWorkspace: {
          ...s.browserPagesByWorkspace,
          [workspaceId]: nextPages
        },
        browserTabsByWorktree: {
          ...s.browserTabsByWorktree,
          [workspace.worktreeId]: (s.browserTabsByWorktree[workspace.worktreeId] ?? []).map((tab) =>
            tab.id === workspaceId ? nextWorkspace : tab
          )
        },
        pendingAddressBarFocusByPageId: shouldFocusAddressBar
          ? {
              ...s.pendingAddressBarFocusByPageId,
              [page.id]: true
            }
          : s.pendingAddressBarFocusByPageId,
        pendingAddressBarFocusByTabId: shouldFocusAddressBar
          ? {
              ...s.pendingAddressBarFocusByTabId,
              [page.id]: true
            }
          : s.pendingAddressBarFocusByTabId
      }
    })

    const nextWorkspace = findWorkspace(get().browserTabsByWorktree, workspaceId)
    if (nextWorkspace?.activePageId === page.id) {
      const item = Object.values(get().unifiedTabsByWorktree)
        .flat()
        .find((entry) => entry.contentType === 'browser' && entry.entityId === workspaceId)
      if (item) {
        get().setTabLabel(item.id, page.title)
      }
    }
    return page
  },

  closeBrowserPage: (pageId) => {
    set((s) => {
      const page = findPage(s.browserPagesByWorkspace, pageId)
      if (!page) {
        return s
      }
      const workspace = findWorkspace(s.browserTabsByWorktree, page.workspaceId)
      if (!workspace) {
        return s
      }
      const currentPages = s.browserPagesByWorkspace[workspace.id] ?? []
      const nextPages = currentPages.filter((entry) => entry.id !== pageId)
      const closedIdx = currentPages.findIndex((entry) => entry.id === pageId)
      const nextActivePageId =
        workspace.activePageId === pageId
          ? ((nextPages[closedIdx] ?? nextPages[closedIdx - 1] ?? null)?.id ?? null)
          : workspace.activePageId
      const nextWorkspace = mirrorWorkspaceFromActivePage(
        {
          ...workspace,
          activePageId: nextActivePageId,
          pageIds: nextPages.map((entry) => entry.id)
        },
        nextPages
      )

      return {
        browserPagesByWorkspace: {
          ...s.browserPagesByWorkspace,
          [workspace.id]: nextPages
        },
        browserTabsByWorktree: {
          ...s.browserTabsByWorktree,
          [workspace.worktreeId]: (s.browserTabsByWorktree[workspace.worktreeId] ?? []).map((tab) =>
            tab.id === workspace.id ? nextWorkspace : tab
          )
        },
        recentlyClosedBrowserPagesByWorkspace: {
          ...s.recentlyClosedBrowserPagesByWorkspace,
          [workspace.id]: [
            page,
            ...(s.recentlyClosedBrowserPagesByWorkspace[workspace.id] ?? []).filter(
              (entry) => entry.id !== page.id
            )
          ].slice(0, 10)
        },
        pendingAddressBarFocusByPageId: Object.fromEntries(
          Object.entries(s.pendingAddressBarFocusByPageId).filter(
            ([pendingPageId]) => pendingPageId !== pageId
          )
        ),
        pendingAddressBarFocusByTabId: Object.fromEntries(
          Object.entries(s.pendingAddressBarFocusByTabId).filter(
            ([pendingPageId]) => pendingPageId !== pageId
          )
        )
      }
    })

    const page = findPage(get().browserPagesByWorkspace, pageId)
    if (!page) {
      return
    }
    const workspace = findWorkspace(get().browserTabsByWorktree, page.workspaceId)
    const item = Object.values(get().unifiedTabsByWorktree)
      .flat()
      .find((entry) => entry.contentType === 'browser' && entry.entityId === page.workspaceId)
    if (item && workspace) {
      get().setTabLabel(item.id, workspace.title)
    }
  },

  reopenClosedBrowserPage: (workspaceId) => {
    // Why: read and pop atomically inside set() to prevent a TOCTOU race
    // where two rapid Cmd+Shift+T presses both restore the same page.
    let pageToRestore: BrowserPage | undefined

    set((s) => {
      const recentlyClosed = s.recentlyClosedBrowserPagesByWorkspace[workspaceId] ?? []
      pageToRestore = recentlyClosed[0]
      if (!pageToRestore) {
        return s
      }
      return {
        recentlyClosedBrowserPagesByWorkspace: {
          ...s.recentlyClosedBrowserPagesByWorkspace,
          [workspaceId]: recentlyClosed.slice(1)
        }
      }
    })

    if (!pageToRestore) {
      return null
    }

    return get().createBrowserPage(workspaceId, pageToRestore.url, {
      title: pageToRestore.title,
      activate: true
    })
  },

  setActiveBrowserPage: (workspaceId, pageId) => {
    set((s) => {
      const workspace = findWorkspace(s.browserTabsByWorktree, workspaceId)
      if (!workspace) {
        return s
      }
      const pages = s.browserPagesByWorkspace[workspaceId] ?? []
      if (!pages.some((page) => page.id === pageId)) {
        return s
      }
      const nextWorkspace = mirrorWorkspaceFromActivePage(
        {
          ...workspace,
          activePageId: pageId
        },
        pages
      )
      return {
        browserTabsByWorktree: {
          ...s.browserTabsByWorktree,
          [workspace.worktreeId]: (s.browserTabsByWorktree[workspace.worktreeId] ?? []).map((tab) =>
            tab.id === workspaceId ? nextWorkspace : tab
          )
        }
      }
    })

    // Why: switching the active page within a workspace changes which guest
    // webContents the CDP bridge should target for agent commands.
    if (typeof window !== 'undefined' && window.api?.browser) {
      window.api.browser.notifyActiveTabChanged({ browserPageId: pageId }).catch(() => {})
    }

    const workspace = findWorkspace(get().browserTabsByWorktree, workspaceId)
    if (!workspace) {
      return
    }
    const item = Object.values(get().unifiedTabsByWorktree)
      .flat()
      .find((entry) => entry.contentType === 'browser' && entry.entityId === workspaceId)
    if (item) {
      get().setTabLabel(item.id, workspace.title)
    }
  },

  focusBrowserTabInWorktree: (worktreeId, browserPageId, options) => {
    // Why: bridge identifies the target by browserPageId (CDP page id stored
    // on BrowserPage.id), but the renderer's tab strip activates a workspace
    // (BrowserWorkspace.id, a local UUID). They diverge whenever a workspace
    // owns more than one page. Walk pageIds in the targeted worktree's tab
    // list to find the owning workspace.
    const tabsForWorktree = get().browserTabsByWorktree[worktreeId] ?? []
    const workspace = tabsForWorktree.find((tab) => (tab.pageIds ?? []).includes(browserPageId))
    if (!workspace) {
      // Best-effort: state for this worktree may not be hydrated yet, or the
      // page closed between the bridge switching and this IPC arriving.
      return
    }
    // Default to true: the only caller (`tab switch --focus` IPC listener)
    // wants the pane surfaced when targeting the active worktree. `false` is
    // an opt-out for hypothetical pure-pre-staging callers.
    const surfacePane = options?.surfacePane ?? true
    const pages = get().browserPagesByWorkspace[workspace.id] ?? []
    const nextWorkspace = mirrorWorkspaceFromActivePage(
      { ...workspace, activePageId: browserPageId },
      pages
    )
    // TODO: per-worktree writes below duplicate setActiveBrowserTab /
    // setActiveBrowserPage. We can't reuse those because they touch globals
    // unconditionally (the very behavior --focus is avoiding). If they ever
    // grow side-effects (analytics, persistence) those will silently diverge
    // here. Consider extracting a private per-worktree-only helper that
    // both call paths share.
    set((s) => {
      const isActiveWorktree = s.activeWorktreeId === worktreeId
      // Per-worktree slots: always update (safe pre-staging; only visible
      // when user navigates to this worktree).
      const nextTabsByWorktree = {
        ...s.browserTabsByWorktree,
        [worktreeId]: tabsForWorktree.map((tab) => (tab.id === workspace.id ? nextWorkspace : tab))
      }
      const nextActiveTabIdByWorktree = {
        ...s.activeBrowserTabIdByWorktree,
        [worktreeId]: workspace.id
      }
      const nextActiveTabTypeByWorktree = surfacePane
        ? { ...s.activeTabTypeByWorktree, [worktreeId]: 'browser' as const }
        : s.activeTabTypeByWorktree
      // Globals: only mutate when the targeted worktree is currently active.
      // This is the line that keeps cross-worktree --focus calls silent.
      return {
        browserTabsByWorktree: nextTabsByWorktree,
        activeBrowserTabIdByWorktree: nextActiveTabIdByWorktree,
        activeTabTypeByWorktree: nextActiveTabTypeByWorktree,
        activeBrowserTabId: isActiveWorktree ? workspace.id : s.activeBrowserTabId,
        activeTabType: isActiveWorktree && surfacePane ? 'browser' : s.activeTabType
      }
    })

    // Why: notify the CDP bridge which guest webContents is now active so
    // subsequent agent commands target the correct page. Mirrors the
    // notifyActiveTabChanged calls in setActiveBrowserTab/setActiveBrowserPage.
    if (typeof window !== 'undefined' && window.api?.browser) {
      window.api.browser.notifyActiveTabChanged({ browserPageId }).catch(() => {})
    }

    // Why: keep the unified-tab strip's active entry in sync within the
    // targeted worktree. activateTab only mutates per-worktree slices, so
    // it's safe to call cross-worktree without yanking the user.
    const item = (get().unifiedTabsByWorktree[worktreeId] ?? []).find(
      (entry) => entry.contentType === 'browser' && entry.entityId === workspace.id
    )
    if (item) {
      get().activateTab(item.id)
    }
  },

  consumeAddressBarFocusRequest: (pageId) => {
    const state = get()
    if (
      !state.pendingAddressBarFocusByPageId[pageId] &&
      !state.pendingAddressBarFocusByTabId[pageId]
    ) {
      return false
    }

    set((s) => {
      const nextByPageId = { ...s.pendingAddressBarFocusByPageId }
      delete nextByPageId[pageId]
      const nextByTabId = { ...s.pendingAddressBarFocusByTabId }
      delete nextByTabId[pageId]
      return {
        pendingAddressBarFocusByPageId: nextByPageId,
        pendingAddressBarFocusByTabId: nextByTabId
      }
    })

    return true
  },

  updateBrowserTabPageState: (pageId, updates) => get().updateBrowserPageState(pageId, updates),

  updateBrowserPageState: (pageId, updates) => {
    set((s) => {
      const page = findPage(s.browserPagesByWorkspace, pageId)
      if (!page) {
        return s
      }
      const workspace = findWorkspace(s.browserTabsByWorktree, page.workspaceId)
      if (!workspace) {
        return s
      }
      const nextPages = (s.browserPagesByWorkspace[workspace.id] ?? []).map((entry) =>
        entry.id === pageId
          ? {
              ...entry,
              title:
                updates.title === undefined
                  ? entry.title
                  : normalizeBrowserTitle(updates.title, entry.url),
              loading: updates.loading ?? entry.loading,
              faviconUrl: updates.faviconUrl === undefined ? entry.faviconUrl : updates.faviconUrl,
              canGoBack: updates.canGoBack ?? entry.canGoBack,
              canGoForward: updates.canGoForward ?? entry.canGoForward,
              loadError: updates.loadError === undefined ? entry.loadError : updates.loadError
            }
          : entry
      )
      const nextWorkspace = mirrorWorkspaceFromActivePage(workspace, nextPages)
      return {
        browserPagesByWorkspace: {
          ...s.browserPagesByWorkspace,
          [workspace.id]: nextPages
        },
        browserTabsByWorktree: {
          ...s.browserTabsByWorktree,
          [workspace.worktreeId]: (s.browserTabsByWorktree[workspace.worktreeId] ?? []).map((tab) =>
            tab.id === workspace.id ? nextWorkspace : tab
          )
        }
      }
    })

    const page = findPage(get().browserPagesByWorkspace, pageId)
    if (!page) {
      return
    }
    const workspace = findWorkspace(get().browserTabsByWorktree, page.workspaceId)
    const item = Object.values(get().unifiedTabsByWorktree)
      .flat()
      .find((entry) => entry.contentType === 'browser' && entry.entityId === page.workspaceId)
    if (item && workspace && workspace.activePageId === pageId && updates.title) {
      get().setTabLabel(item.id, workspace.title)
    }
  },

  setBrowserTabUrl: (pageId, url) => get().setBrowserPageUrl(pageId, url),

  setBrowserPageUrl: (pageId, url) =>
    set((s) => {
      const page = findPage(s.browserPagesByWorkspace, pageId)
      if (!page) {
        return s
      }
      const workspace = findWorkspace(s.browserTabsByWorktree, page.workspaceId)
      if (!workspace) {
        return s
      }
      const nextPages = (s.browserPagesByWorkspace[workspace.id] ?? []).map((entry) =>
        entry.id === pageId
          ? {
              ...entry,
              url: normalizeUrl(url),
              title: normalizeBrowserTitle(entry.title, normalizeUrl(url)),
              loading: true,
              loadError: null
            }
          : entry
      )
      const nextWorkspace = mirrorWorkspaceFromActivePage(workspace, nextPages)
      return {
        browserPagesByWorkspace: {
          ...s.browserPagesByWorkspace,
          [workspace.id]: nextPages
        },
        browserTabsByWorktree: {
          ...s.browserTabsByWorktree,
          [workspace.worktreeId]: (s.browserTabsByWorktree[workspace.worktreeId] ?? []).map((tab) =>
            tab.id === workspace.id ? nextWorkspace : tab
          )
        }
      }
    }),

  // viewportPresetId is a per-page setting on BrowserPage and is intentionally not
  // mirrored onto BrowserWorkspace: the outer tab strip doesn't surface the preset,
  // so there's no UI consumer at the workspace layer. Keeping it page-local avoids
  // cross-layer plumbing; do NOT add mirrorWorkspaceFromActivePage here.
  setBrowserPageViewportPreset: (pageId, viewportPresetId) =>
    set((s) => {
      const page = findPage(s.browserPagesByWorkspace, pageId)
      if (!page) {
        return s
      }
      const workspace = findWorkspace(s.browserTabsByWorktree, page.workspaceId)
      if (!workspace) {
        return s
      }
      const nextPages = (s.browserPagesByWorkspace[workspace.id] ?? []).map((entry) =>
        entry.id === pageId ? { ...entry, viewportPresetId } : entry
      )
      return {
        browserPagesByWorkspace: {
          ...s.browserPagesByWorkspace,
          [workspace.id]: nextPages
        }
      }
    }),

  hydrateBrowserSession: (session) => {
    const persistedTabsByWorktree = session.browserTabsByWorktree ?? {}
    const currentState = get()
    const validWorktreeIdsForCleanup = new Set(
      Object.values(currentState.worktreesByRepo)
        .flat()
        .map((worktree) => worktree.id)
    )

    // Why: mirror closeBrowserTab's contract — reducers are pure, imperative
    // side effects bracket them. Compute dropped workspaces first, destroy
    // their webviews, then run the state reducer unchanged. hydrate is called
    // once at boot (App.tsx) when the webview registry is empty, so this loop
    // is a no-op today; it's defense-in-depth for any future caller that
    // re-hydrates after webviews are live.
    const droppedWorkspaceIds: string[] = []
    for (const [worktreeId, tabs] of Object.entries(persistedTabsByWorktree)) {
      if (!validWorktreeIdsForCleanup.has(worktreeId)) {
        for (const tab of tabs) {
          droppedWorkspaceIds.push(tab.id)
        }
      }
    }
    for (const workspaceId of droppedWorkspaceIds) {
      destroyWorkspaceWebviews(currentState.browserPagesByWorkspace, workspaceId)
    }

    set((s) => {
      const persistedPagesByWorkspace = session.browserPagesByWorkspace ?? {}
      const persistedActiveBrowserTabIdByWorktree = session.activeBrowserTabIdByWorktree ?? {}
      const persistedActiveTabTypeByWorktree = session.activeTabTypeByWorktree ?? {}
      const validWorktreeIds = new Set(
        Object.values(s.worktreesByRepo)
          .flat()
          .map((worktree) => worktree.id)
      )

      const browserTabsByWorktree: Record<string, BrowserWorkspace[]> = {}
      const browserPagesByWorkspace: Record<string, BrowserPage[]> = {}

      for (const [worktreeId, tabs] of Object.entries(persistedTabsByWorktree)) {
        if (!validWorktreeIds.has(worktreeId)) {
          continue
        }
        const hydratedTabs: BrowserWorkspace[] = []
        for (const tab of tabs) {
          const persistedPages = persistedPagesByWorkspace[tab.id] ?? [
            {
              id: globalThis.crypto.randomUUID(),
              workspaceId: tab.id,
              worktreeId,
              url: normalizeUrl(tab.url),
              title: tab.title,
              loading: false,
              faviconUrl: tab.faviconUrl ?? null,
              canGoBack: tab.canGoBack,
              canGoForward: tab.canGoForward,
              loadError: tab.loadError ?? null,
              createdAt: tab.createdAt
            } satisfies BrowserPage
          ]
          const nextPages = persistedPages.map((page) => ({
            ...page,
            workspaceId: tab.id,
            worktreeId,
            url: normalizeUrl(page.url),
            loading: false,
            loadError: page.loadError ?? null
          }))
          browserPagesByWorkspace[tab.id] = nextPages
          hydratedTabs.push(
            mirrorWorkspaceFromActivePage(
              {
                ...tab,
                activePageId: nextPages.some((page) => page.id === tab.activePageId)
                  ? (tab.activePageId ?? nextPages[0]?.id ?? null)
                  : (nextPages[0]?.id ?? null),
                pageIds: nextPages.map((page) => page.id)
              },
              nextPages
            )
          )
        }
        if (hydratedTabs.length > 0) {
          browserTabsByWorktree[worktreeId] = hydratedTabs
        }
      }

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

      const nextActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
      for (const worktreeId of validWorktreeIds) {
        const hasBrowserTabs = (browserTabsByWorktree[worktreeId] ?? []).length > 0
        if (
          persistedActiveTabTypeByWorktree[worktreeId] === 'browser' &&
          hasBrowserTabs &&
          !nextActiveTabTypeByWorktree[worktreeId]
        ) {
          nextActiveTabTypeByWorktree[worktreeId] = 'browser'
          continue
        }
        if (nextActiveTabTypeByWorktree[worktreeId] === 'browser' && !hasBrowserTabs) {
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
        browserPagesByWorkspace,
        activeBrowserTabIdByWorktree,
        activeBrowserTabId,
        activeTabTypeByWorktree: nextActiveTabTypeByWorktree,
        activeTabType,
        browserUrlHistory: normalizeBrowserHistoryEntries(session.browserUrlHistory ?? [])
      }
    })

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
  },

  switchBrowserTabProfile: (workspaceId, profileId) => {
    set((s) => {
      for (const [worktreeId, tabs] of Object.entries(s.browserTabsByWorktree)) {
        const tabIndex = tabs.findIndex((t) => t.id === workspaceId)
        if (tabIndex !== -1) {
          const updatedTabs = [...tabs]
          updatedTabs[tabIndex] = { ...updatedTabs[tabIndex], sessionProfileId: profileId }
          return {
            browserTabsByWorktree: {
              ...s.browserTabsByWorktree,
              [worktreeId]: updatedTabs
            }
          }
        }
      }
      return {}
    })
  },

  fetchBrowserSessionProfiles: async () => {
    try {
      const profiles = (await window.api.browser.sessionListProfiles()) as BrowserSessionProfile[]
      set({ browserSessionProfiles: profiles })
    } catch {
      /* best-effort — stale profile list is preferable to a crash */
    }
  },

  createBrowserSessionProfile: async (scope, label) => {
    try {
      const profile = (await window.api.browser.sessionCreateProfile({
        scope,
        label
      })) as BrowserSessionProfile | null
      if (profile) {
        set((s) => ({
          browserSessionProfiles: [...s.browserSessionProfiles, profile]
        }))
      }
      return profile
    } catch {
      return null
    }
  },

  deleteBrowserSessionProfile: async (profileId) => {
    try {
      const ok = await window.api.browser.sessionDeleteProfile({ profileId })
      if (ok) {
        set((s) => ({
          browserSessionProfiles: s.browserSessionProfiles.filter((p) => p.id !== profileId),
          ...(s.defaultBrowserSessionProfileId === profileId
            ? { defaultBrowserSessionProfileId: null }
            : {})
        }))
      }
      return ok
    } catch {
      return false
    }
  },

  importCookiesToProfile: async (profileId) => {
    set({
      browserSessionImportState: {
        profileId,
        status: 'importing',
        summary: null,
        error: null
      }
    })
    try {
      const result = (await window.api.browser.sessionImportCookies({
        profileId
      })) as BrowserCookieImportResult
      if (result.ok) {
        set({
          browserSessionImportState: {
            profileId,
            status: 'success',
            summary: result.summary,
            error: null
          }
        })
        await get()
          .fetchBrowserSessionProfiles()
          .catch(() => {})
      } else {
        set({
          browserSessionImportState: {
            profileId,
            status: result.reason === 'canceled' ? 'idle' : 'error',
            summary: null,
            error: result.reason === 'canceled' ? null : result.reason
          }
        })
      }
      return result
    } catch (err) {
      const reason = String((err as Error)?.message ?? err)
      set({
        browserSessionImportState: {
          profileId,
          status: 'error',
          summary: null,
          error: reason
        }
      })
      return { ok: false as const, reason }
    }
  },

  clearBrowserSessionImportState: () => {
    set({ browserSessionImportState: null })
  },

  detectedBrowsers: [],
  detectedBrowsersLoaded: false,

  fetchDetectedBrowsers: async () => {
    if (get().detectedBrowsersLoaded) {
      return
    }
    try {
      const browsers = (await window.api.browser.sessionDetectBrowsers()) as {
        family: string
        label: string
        profiles: { name: string; directory: string }[]
        selectedProfile: string
      }[]
      set({ detectedBrowsers: browsers, detectedBrowsersLoaded: true })
    } catch {
      /* best-effort — empty list is acceptable fallback */
      set({ detectedBrowsersLoaded: true })
    }
  },

  importCookiesFromBrowser: async (profileId, browserFamily, browserProfile?) => {
    set({
      browserSessionImportState: {
        profileId,
        status: 'importing',
        summary: null,
        error: null
      }
    })
    try {
      const result = (await window.api.browser.sessionImportFromBrowser({
        profileId,
        browserFamily,
        browserProfile
      })) as BrowserCookieImportResult
      if (result.ok) {
        set({
          browserSessionImportState: {
            profileId,
            status: 'success',
            summary: result.summary,
            error: null
          }
        })
        await get()
          .fetchBrowserSessionProfiles()
          .catch(() => {})
      } else {
        set({
          browserSessionImportState: {
            profileId,
            status: 'error',
            summary: null,
            error: result.reason
          }
        })
      }
      return result
    } catch (err) {
      const reason = String((err as Error)?.message ?? err)
      set({
        browserSessionImportState: {
          profileId,
          status: 'error',
          summary: null,
          error: reason
        }
      })
      return { ok: false as const, reason }
    }
  },

  clearDefaultSessionCookies: async () => {
    try {
      const ok = await window.api.browser.sessionClearDefaultCookies()
      if (ok) {
        await get().fetchBrowserSessionProfiles()
      }
      return ok
    } catch {
      return false
    }
  },

  addBrowserHistoryEntry: (url, title) => {
    const safeUrl = redactKagiSessionToken(url)
    if (safeUrl === ORCA_BROWSER_BLANK_URL || safeUrl === 'about:blank' || !safeUrl) {
      return
    }
    const normalized = normalizeBrowserHistoryUrl(safeUrl)
    set((s) => {
      const existing = s.browserUrlHistory.find((entry) => entry.normalizedUrl === normalized)
      let next: BrowserHistoryEntry[] = existing
        ? s.browserUrlHistory.map((entry) =>
            entry === existing
              ? { ...entry, title, lastVisitedAt: Date.now(), visitCount: entry.visitCount + 1 }
              : entry
          )
        : [
            {
              url: safeUrl,
              normalizedUrl: normalized,
              title,
              lastVisitedAt: Date.now(),
              visitCount: 1
            },
            ...s.browserUrlHistory
          ]
      if (next.length > MAX_BROWSER_HISTORY_ENTRIES) {
        next = next
          .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
          .slice(0, MAX_BROWSER_HISTORY_ENTRIES)
      }
      return { browserUrlHistory: next }
    })
  },

  clearBrowserHistory: () => set({ browserUrlHistory: [] })
})
