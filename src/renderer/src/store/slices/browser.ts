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
  BrowserWorkspace,
  WorkspaceSessionState
} from '../../../../shared/types'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'
import { pickNeighbor } from './tab-group-state'

type CreateBrowserTabOptions = {
  activate?: boolean
  title?: string
  sessionProfileId?: string | null
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
  consumeAddressBarFocusRequest: (pageId: string) => boolean
  updateBrowserTabPageState: (pageId: string, updates: BrowserTabPageState) => void
  updateBrowserPageState: (pageId: string, updates: BrowserTabPageState) => void
  setBrowserTabUrl: (pageId: string, url: string) => void
  setBrowserPageUrl: (pageId: string, url: string) => void
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

const MAX_BROWSER_HISTORY_ENTRIES = 200

function normalizeHistoryUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hostname = parsed.hostname.toLowerCase()
    parsed.protocol = parsed.protocol.toLowerCase()
    let normalized = parsed.toString()
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1)
    }
    return normalized
  } catch {
    return url.toLowerCase()
  }
}

function deduplicateHistory(entries: BrowserHistoryEntry[]): BrowserHistoryEntry[] {
  const seen = new Set<string>()
  const deduped: BrowserHistoryEntry[] = []
  for (const entry of entries) {
    const key = entry.normalizedUrl || normalizeHistoryUrl(entry.url)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(entry.normalizedUrl ? entry : { ...entry, normalizedUrl: key })
  }
  return deduped.slice(0, MAX_BROWSER_HISTORY_ENTRIES)
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  if (trimmed.length === 0) {
    return 'about:blank'
  }
  return trimmed
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
        (page.url === 'about:blank' || page.url === ORCA_BROWSER_BLANK_URL)

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
        label: browserTab.title
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

  hydrateBrowserSession: (session) => {
    set((s) => {
      const persistedTabsByWorktree = session.browserTabsByWorktree ?? {}
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
        browserUrlHistory: deduplicateHistory(session.browserUrlHistory ?? [])
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

  fetchDetectedBrowsers: async () => {
    try {
      const browsers = (await window.api.browser.sessionDetectBrowsers()) as {
        family: string
        label: string
        profiles: { name: string; directory: string }[]
        selectedProfile: string
      }[]
      set({ detectedBrowsers: browsers })
    } catch {
      /* best-effort — empty list is acceptable fallback */
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
    if (url === ORCA_BROWSER_BLANK_URL || url === 'about:blank' || !url) {
      return
    }
    const normalized = normalizeHistoryUrl(url)
    set((s) => {
      const existing = s.browserUrlHistory.find((entry) => entry.normalizedUrl === normalized)
      let next: BrowserHistoryEntry[] = existing
        ? s.browserUrlHistory.map((entry) =>
            entry === existing
              ? { ...entry, title, lastVisitedAt: Date.now(), visitCount: entry.visitCount + 1 }
              : entry
          )
        : [
            { url, normalizedUrl: normalized, title, lastVisitedAt: Date.now(), visitCount: 1 },
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
