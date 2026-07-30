/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  BrowserCookieImportResult,
  BrowserCookieImportSummary,
  BrowserCertificateFailure,
  BrowserHistoryEntry,
  BrowserLoadError,
  BrowserPage,
  BrowserSessionProfile,
  BrowserViewportPresetId,
  BrowserWorkspace,
  WorkspaceSessionState
} from '../../../../shared/types'
import { GRAB_BUDGET, type BrowserPageAnnotation } from '../../../../shared/browser-grab-types'
import { FLOATING_TERMINAL_WORKTREE_ID, ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { redactKagiSessionToken } from '../../../../shared/browser-url'
import {
  MAX_BROWSER_HISTORY_ENTRIES,
  normalizeBrowserHistoryEntries,
  normalizeBrowserHistoryUrl
} from '../../../../shared/workspace-session-browser-history'
import { pickNeighbor } from './tab-group-state'
import { destroyWorkspaceWebviews } from './browser-webview-cleanup'
import { pushRecentlyClosedTabKind } from './recently-closed-tabs'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type {
  BrowserDetectProfilesResult,
  BrowserProfileClearDefaultCookiesResult,
  BrowserProfileCreateResult,
  BrowserProfileDeleteResult,
  BrowserProfileImportFromBrowserResult,
  BrowserProfileListResult
} from '../../../../shared/runtime-types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'
import {
  getSettingsFocusedExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'
import {
  addAdditionalValidWorkspaceKeys,
  type WorkspaceSessionHydrationOptions
} from '@/lib/workspace-session-hydration-keys'
import { buildValidWorktreeIdsForSessionHydration } from './degraded-repo-worktree-validity'

type CreateBrowserTabOptions = {
  activate?: boolean
  title?: string
  sessionProfileId?: string | null
  sessionPartition?: string | null
  // Place the new tab in a specific group (e.g. "Open Preview to the Side"); defaults to the worktree's active group.
  targetGroupId?: string
  // Explicit "New Tab" focuses the address bar even with a real home URL; link-opened tabs leave it unset.
  focusAddressBar?: boolean
  browserRuntimeEnvironmentId?: string | null
}

type CreateBrowserPageOptions = {
  activate?: boolean
  title?: string
  browserRuntimeEnvironmentId?: string | null
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

function sanitizeBrowserPageAnnotation(annotation: BrowserPageAnnotation): BrowserPageAnnotation {
  return {
    ...annotation,
    comment:
      annotation.comment.length > GRAB_BUDGET.annotationCommentMaxLength
        ? annotation.comment.slice(0, GRAB_BUDGET.annotationCommentMaxLength)
        : annotation.comment,
    payload: {
      ...annotation.payload,
      // Why: annotations persist to disk; null the transient screenshot to avoid retaining megabytes per note.
      screenshot: null
    }
  }
}

export type RemoteBrowserPageHandle = {
  environmentId: string
  remotePageId: string
}

export type BrowserSlice = {
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>
  browserPagesByWorkspace: Record<string, BrowserPage[]>
  browserCertificateFailuresByPageId: Record<string, BrowserCertificateFailure>
  browserAnnotationsByPageId: Record<string, BrowserPageAnnotation[]>
  remoteBrowserPageHandlesByPageId: Record<string, RemoteBrowserPageHandle>
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
  openNewBrowserTabInActiveWorkspace: (groupId: string) => Promise<void>
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
  // Focus that never yanks the user across worktrees: per-worktree slots always update, globals only when targeting the active worktree.
  focusBrowserTabInWorktree: (
    worktreeId: string,
    browserPageId: string,
    options?: { surfacePane?: boolean }
  ) => void
  consumeAddressBarFocusRequest: (pageId: string) => boolean
  updateBrowserTabPageState: (pageId: string, updates: BrowserTabPageState) => void
  updateBrowserPageState: (pageId: string, updates: BrowserTabPageState) => void
  setBrowserPageCertificateFailure: (
    pageId: string,
    failure: BrowserCertificateFailure | null
  ) => void
  setBrowserTabUrl: (pageId: string, url: string) => void
  setBrowserPageUrl: (pageId: string, url: string) => void
  setRemoteBrowserPageHandle: (pageId: string, handle: RemoteBrowserPageHandle) => void
  removeRemoteBrowserPageHandle: (
    pageId: string,
    remotePageId?: string
  ) => RemoteBrowserPageHandle | null
  setBrowserPageViewportPreset: (
    pageId: string,
    viewportPresetId: BrowserViewportPresetId | null
  ) => void
  addBrowserPageAnnotation: (annotation: BrowserPageAnnotation) => void
  deleteBrowserPageAnnotation: (pageId: string, annotationId: string) => void
  clearBrowserPageAnnotations: (pageId: string) => void
  hydrateBrowserSession: (
    session: WorkspaceSessionState,
    options?: WorkspaceSessionHydrationOptions
  ) => void
  switchBrowserTabProfile: (
    workspaceId: string,
    profileId: string | null,
    sessionPartition?: string | null
  ) => void
  browserSessionProfiles: BrowserSessionProfile[]
  browserSessionProfilesByHostId: Partial<Record<ExecutionHostId, BrowserSessionProfile[]>>
  browserSessionHostIdOverride: ExecutionHostId | null
  setBrowserSessionHostId: (hostId: ExecutionHostId) => Promise<void>
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
  defaultBrowserSessionProfileIdByHostId: Partial<Record<ExecutionHostId, string | null>>
  setDefaultBrowserSessionProfileId: (profileId: string | null) => void
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  if (trimmed.length === 0) {
    return 'about:blank'
  }
  // Why: redact at this single URL sink so the Kagi bearer token can't reach BrowserPage.url, which is persisted to disk.
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
    // Why: don't surface the internal blank-guest URL as a title (leaks an impl detail, looks broken); show "New Tab" instead.
    return 'New Tab'
  }
  return title
}

function getBrowserSettingsHostId(
  state: Pick<AppState, 'browserSessionHostIdOverride' | 'settings'>
): ExecutionHostId {
  return state.browserSessionHostIdOverride ?? getSettingsFocusedExecutionHostId(state.settings)
}

function getBrowserSettingsRuntimeEnvironmentId(
  state: Pick<AppState, 'browserSessionHostIdOverride' | 'settings'>
): string | null {
  const parsed = parseExecutionHostId(getBrowserSettingsHostId(state))
  return parsed?.kind === 'runtime' ? parsed.environmentId : null
}

function getBrowserWorktreeHostId(state: AppState, worktreeId: string): ExecutionHostId {
  return getExecutionHostIdForWorktree(state, worktreeId)
}

function getBrowserSessionProfileHostId(
  state: AppState,
  worktreeId: string,
  browserRuntimeEnvironmentId: string | null | undefined
): ExecutionHostId {
  if (browserRuntimeEnvironmentId === null) {
    return LOCAL_EXECUTION_HOST_ID
  }
  if (browserRuntimeEnvironmentId !== undefined) {
    const runtimeEnvironmentId = browserRuntimeEnvironmentId.trim()
    return runtimeEnvironmentId
      ? toRuntimeExecutionHostId(runtimeEnvironmentId)
      : LOCAL_EXECUTION_HOST_ID
  }
  return getBrowserWorktreeHostId(state, worktreeId)
}

export function isLocalBrowserPageOwner(
  state: AppState,
  worktreeId: string,
  browserRuntimeEnvironmentId: string | null | undefined
): boolean {
  return (
    parseExecutionHostId(
      getBrowserSessionProfileHostId(state, worktreeId, browserRuntimeEnvironmentId)
    )?.kind !== 'runtime'
  )
}

function profileListByHostUpdate(
  state: Pick<
    AppState,
    'browserSessionHostIdOverride' | 'browserSessionProfilesByHostId' | 'settings'
  >,
  profiles: BrowserSessionProfile[],
  hostId: ExecutionHostId = getBrowserSettingsHostId(state)
): Partial<BrowserSlice> {
  return {
    ...(getBrowserSettingsHostId(state) === hostId ? { browserSessionProfiles: profiles } : {}),
    browserSessionProfilesByHostId: {
      ...state.browserSessionProfilesByHostId,
      [hostId]: profiles
    }
  }
}

function getBrowserProfilesForHost(
  state: AppState,
  hostId: ExecutionHostId
): BrowserSessionProfile[] {
  return (
    state.browserSessionProfilesByHostId[hostId] ??
    (getBrowserSettingsHostId(state) === hostId ? state.browserSessionProfiles : [])
  )
}

function getDefaultBrowserProfileForHost(state: AppState, hostId: ExecutionHostId): string | null {
  return (
    state.defaultBrowserSessionProfileIdByHostId[hostId] ??
    (getBrowserSettingsHostId(state) === hostId ? state.defaultBrowserSessionProfileId : null)
  )
}

function browserImportStateForHostUpdate(
  state: AppState,
  hostId: ExecutionHostId,
  browserSessionImportState: BrowserSlice['browserSessionImportState']
): Partial<BrowserSlice> {
  return getBrowserSettingsHostId(state) === hostId ? { browserSessionImportState } : {}
}

function closeRemoteBrowserPageInOwningEnvironment(
  worktreeId: string,
  handle: RemoteBrowserPageHandle
): void {
  const target: RuntimeClientTarget = { kind: 'environment', environmentId: handle.environmentId }
  void callRuntimeRpc(
    target,
    'browser.tabClose',
    { worktree: toRuntimeWorktreeSelector(worktreeId), page: handle.remotePageId },
    { timeoutMs: 15_000 }
  ).catch(() => {})
}

function buildBrowserPage(
  workspaceId: string,
  worktreeId: string,
  url: string,
  title?: string,
  browserRuntimeEnvironmentId?: string | null
): BrowserPage {
  const normalizedUrl = normalizeUrl(url)
  return {
    id: createBrowserUuid(),
    workspaceId,
    worktreeId,
    url: normalizedUrl,
    title: normalizeBrowserTitle(title, normalizedUrl),
    // Why: blank pages mount an inert guest (no real navigation); marking them loading would flash the loading affordance.
    loading: normalizedUrl !== 'about:blank' && normalizedUrl !== ORCA_BROWSER_BLANK_URL,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: Date.now(),
    ...(browserRuntimeEnvironmentId !== undefined ? { browserRuntimeEnvironmentId } : {})
  }
}

function buildWorkspaceFromPage(
  id: string,
  worktreeId: string,
  page: BrowserPage,
  pageIds: string[],
  sessionProfileId?: string | null,
  sessionPartition?: string | null
): BrowserWorkspace {
  return {
    id,
    worktreeId,
    sessionProfileId: sessionProfileId ?? null,
    sessionPartition: sessionPartition ?? null,
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
      title: translate('auto.store.slices.browser.08fc23631d', 'Browser'),
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

function browserWorkspaceMirrorFieldsEqual(
  workspace: BrowserWorkspace,
  mirrored: BrowserWorkspace
): boolean {
  const workspacePageIds = workspace.pageIds ?? []
  const mirroredPageIds = mirrored.pageIds ?? []
  return (
    workspace.activePageId === mirrored.activePageId &&
    workspacePageIds.length === mirroredPageIds.length &&
    workspacePageIds.every((pageId, index) => pageId === mirroredPageIds[index]) &&
    workspace.url === mirrored.url &&
    workspace.title === mirrored.title &&
    workspace.loading === mirrored.loading &&
    workspace.faviconUrl === mirrored.faviconUrl &&
    workspace.canGoBack === mirrored.canGoBack &&
    workspace.canGoForward === mirrored.canGoForward &&
    workspace.loadError === mirrored.loadError
  )
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

const browserWorkspaceByIdCache = new WeakMap<
  Record<string, BrowserWorkspace[]>,
  Map<string, BrowserWorkspace>
>()
const browserPageByIdCache = new WeakMap<Record<string, BrowserPage[]>, Map<string, BrowserPage>>()

function findWorkspace(
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>,
  workspaceId: string
): BrowserWorkspace | null {
  const cached = browserWorkspaceByIdCache.get(browserTabsByWorktree)
  if (cached) {
    return cached.get(workspaceId) ?? null
  }
  const workspaceById = new Map<string, BrowserWorkspace>()
  for (const workspaces of Object.values(browserTabsByWorktree)) {
    for (const workspace of workspaces) {
      workspaceById.set(workspace.id, workspace)
    }
  }
  browserWorkspaceByIdCache.set(browserTabsByWorktree, workspaceById)
  return workspaceById.get(workspaceId) ?? null
}

function findPage(
  browserPagesByWorkspace: Record<string, BrowserPage[]>,
  pageId: string
): BrowserPage | null {
  const cached = browserPageByIdCache.get(browserPagesByWorkspace)
  if (cached) {
    return cached.get(pageId) ?? null
  }
  const pageById = new Map<string, BrowserPage>()
  for (const pages of Object.values(browserPagesByWorkspace)) {
    for (const page of pages) {
      pageById.set(page.id, page)
    }
  }
  browserPageByIdCache.set(browserPagesByWorkspace, pageById)
  return pageById.get(pageId) ?? null
}

export const createBrowserSlice: StateCreator<AppState, [], [], BrowserSlice> = (set, get) => ({
  browserTabsByWorktree: {},
  browserPagesByWorkspace: {},
  browserCertificateFailuresByPageId: {},
  browserAnnotationsByPageId: {},
  remoteBrowserPageHandlesByPageId: {},
  activeBrowserTabId: null,
  activeBrowserTabIdByWorktree: {},
  recentlyClosedBrowserTabsByWorktree: {},
  recentlyClosedBrowserPagesByWorkspace: {},
  pendingAddressBarFocusByTabId: {},
  pendingAddressBarFocusByPageId: {},
  browserSessionProfiles: [],
  browserSessionProfilesByHostId: {},
  browserSessionHostIdOverride: null,
  browserSessionImportState: null,
  browserUrlHistory: [],
  defaultBrowserSessionProfileId: null,
  defaultBrowserSessionProfileIdByHostId: {},

  setBrowserSessionHostId: async (hostId) => {
    const parsed = parseExecutionHostId(hostId)
    if (parsed?.kind !== 'local' && parsed?.kind !== 'runtime') {
      return
    }
    const nextHostId = parsed.id
    set((s) => ({
      browserSessionHostIdOverride: nextHostId,
      browserSessionProfiles: s.browserSessionProfilesByHostId[nextHostId] ?? [],
      defaultBrowserSessionProfileId: s.defaultBrowserSessionProfileIdByHostId[nextHostId] ?? null,
      browserSessionImportState: null,
      detectedBrowsers: [],
      detectedBrowsersLoaded: false
    }))
    await Promise.all([get().fetchBrowserSessionProfiles(), get().fetchDetectedBrowsers()])
  },

  setDefaultBrowserSessionProfileId: (profileId) => {
    set((s) => ({
      defaultBrowserSessionProfileId: profileId,
      defaultBrowserSessionProfileIdByHostId: {
        ...s.defaultBrowserSessionProfileIdByHostId,
        [getBrowserSettingsHostId(s)]: profileId
      }
    }))
  },

  createBrowserTab: (worktreeId, url, options) => {
    const workspaceId = createBrowserUuid()
    const page = buildBrowserPage(
      workspaceId,
      worktreeId,
      url,
      options?.title,
      options?.browserRuntimeEnvironmentId
    )
    // Why: with no explicit profile, inherit the user's default so a Settings preference applies to new tabs.
    const sessionProfileId =
      options?.sessionProfileId !== undefined
        ? options.sessionProfileId
        : (get().defaultBrowserSessionProfileIdByHostId[
            getBrowserSessionProfileHostId(get(), worktreeId, options?.browserRuntimeEnvironmentId)
          ] ?? get().defaultBrowserSessionProfileId)
    const browserTab = buildWorkspaceFromPage(
      workspaceId,
      worktreeId,
      page,
      [page.id],
      sessionProfileId,
      options?.sessionPartition
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
      const shouldFocusFloatingTab = shouldActivate && worktreeId === FLOATING_TERMINAL_WORKTREE_ID
      const shouldFocusAddressBar =
        (shouldUpdateGlobalActiveSurface || shouldFocusFloatingTab) &&
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
        activeBrowserTabId: shouldUpdateGlobalActiveSurface ? workspaceId : s.activeBrowserTabId,
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
        targetGroupId: options?.targetGroupId,
        activate: options?.activate ?? true
      })
    }
    return browserTab
  },

  openNewBrowserTabInActiveWorkspace: async (groupId) => {
    const state = get()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      return
    }
    const defaultUrl = state.browserDefaultUrl ?? 'about:blank'
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
    if (runtimeEnvironmentId) {
      const { createWebRuntimeSessionBrowserTab } = await import('@/runtime/web-runtime-session')
      try {
        const created = await createWebRuntimeSessionBrowserTab({
          worktreeId,
          environmentId: runtimeEnvironmentId,
          url: defaultUrl,
          targetGroupId: groupId
        })
        if (created) {
          get().recordFeatureInteraction('browser-tab-created')
          return
        }
      } catch (error) {
        // Why: browser.headless.v1 remotes succeed above, so a failure here is real; surface it instead of a confusing local-tab fallback (split ownership).
        console.warn(
          '[browser] remote browser tab creation failed:',
          error instanceof Error ? error.message : String(error)
        )
      }
      return
    }
    get().createBrowserTab(worktreeId, defaultUrl, {
      title: translate('auto.store.slices.browser.d175274b6d', 'New Browser Tab'),
      focusAddressBar: true,
      targetGroupId: groupId
    })
    get().recordFeatureInteraction('browser-tab-created')
  },
  closeBrowserTab: (tabId) => {
    let remotePagesToClose: { worktreeId: string; handle: RemoteBrowserPageHandle }[] = []
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
      const nextBrowserAnnotationsByPageId = { ...s.browserAnnotationsByPageId }
      const nextBrowserCertificateFailuresByPageId = {
        ...s.browserCertificateFailuresByPageId
      }
      for (const page of closedPages) {
        delete nextBrowserAnnotationsByPageId[page.id]
        delete nextBrowserCertificateFailuresByPageId[page.id]
      }
      remotePagesToClose = closedPages.flatMap((page) => {
        const handle = s.remoteBrowserPageHandlesByPageId[page.id]
        return handle ? [{ worktreeId: page.worktreeId, handle }] : []
      })
      const nextRemoteBrowserPageHandlesByPageId = {
        ...s.remoteBrowserPageHandlesByPageId
      }
      for (const page of closedPages) {
        delete nextRemoteBrowserPageHandlesByPageId[page.id]
      }

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
      const nextRecentlyClosedTabKindsByWorktree = pushRecentlyClosedTabKind(
        s.recentlyClosedTabKindsByWorktree,
        owningWorktreeId,
        'browser'
      )

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
        recentlyClosedTabKindsByWorktree: nextRecentlyClosedTabKindsByWorktree,
        recentlyClosedBrowserPagesByWorkspace: nextRecentlyClosedBrowserPagesByWorkspace,
        remoteBrowserPageHandlesByPageId: nextRemoteBrowserPageHandlesByPageId,
        browserCertificateFailuresByPageId: nextBrowserCertificateFailuresByPageId,
        browserAnnotationsByPageId: nextBrowserAnnotationsByPageId
      }
    })

    for (const remotePage of remotePagesToClose) {
      closeRemoteBrowserPageInOwningEnvironment(remotePage.worktreeId, remotePage.handle)
    }

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
    // Why: snapshot before the loop — closeBrowserTab empties the array, so set() below couldn't recompute hadBrowserTabs.
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
      // Why: reset the global browser surface only when the shut-down worktree is the active one AND had tabs.
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
    // Why: read and pop atomically inside set() so two rapid Cmd+Shift+T presses can't both restore the same entry (TOCTOU).
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
    const sessionPartition = snap.sessionPartition ?? null

    if (pages.length === 0) {
      const restored = get().createBrowserTab(worktreeId, snap.url, {
        title: snap.title,
        activate: true,
        sessionProfileId,
        sessionPartition
      })
      return get().browserTabsByWorktree[worktreeId]?.find((tab) => tab.id === restored.id) ?? null
    }

    // Why: append remaining pages in original order so multi-page workspaces preserve their page sequence.
    const [firstPage, ...restPages] = pages
    const restored = get().createBrowserTab(worktreeId, firstPage.url, {
      title: firstPage.title,
      activate: true,
      sessionProfileId,
      sessionPartition,
      browserRuntimeEnvironmentId: firstPage.browserRuntimeEnvironmentId
    })

    for (const p of restPages) {
      get().createBrowserPage(restored.id, p.url, {
        activate: false,
        title: p.title,
        browserRuntimeEnvironmentId: p.browserRuntimeEnvironmentId
      })
    }

    // Why: duplicate URLs are valid, so matching by URL can pick the wrong copy; restore preserves order, so map by index.
    const activePageId = snap.activePageId
    if (activePageId) {
      const restoredPages = get().browserPagesByWorkspace[restored.id] ?? []
      const activePageIndex = pages.findIndex((orig) => orig.id === activePageId)
      const targetPage = activePageIndex >= 0 ? restoredPages[activePageIndex] : null
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

    // Why: notify the CDP bridge of the active guest; it keys on page IDs not workspace IDs, so resolve the workspace's active page.
    const workspace = findWorkspace(get().browserTabsByWorktree, tabId)
    const activePage = workspace?.activePageId
      ? (get().browserPagesByWorkspace[workspace.id] ?? []).find(
          (page) => page.id === workspace.activePageId
        )
      : undefined
    if (
      workspace?.activePageId &&
      isLocalBrowserPageOwner(
        get(),
        workspace.worktreeId,
        activePage?.browserRuntimeEnvironmentId
      ) &&
      typeof window !== 'undefined' &&
      window.api?.browser
    ) {
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
    const page = buildBrowserPage(
      workspaceId,
      workspace.worktreeId,
      url,
      options?.title,
      options?.browserRuntimeEnvironmentId
    )

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
    let closedWorkspaceIdForLabel: string | null = null
    const remotePagesToClose: { worktreeId: string; handle: RemoteBrowserPageHandle }[] = []
    set((s) => {
      const page = findPage(s.browserPagesByWorkspace, pageId)
      if (!page) {
        return s
      }
      const workspace = findWorkspace(s.browserTabsByWorktree, page.workspaceId)
      if (!workspace) {
        return s
      }
      closedWorkspaceIdForLabel = page.workspaceId
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
      const remoteHandle = s.remoteBrowserPageHandlesByPageId[pageId]
      if (remoteHandle) {
        remotePagesToClose.push({ worktreeId: page.worktreeId, handle: remoteHandle })
      }
      const nextRemoteBrowserPageHandlesByPageId = {
        ...s.remoteBrowserPageHandlesByPageId
      }
      delete nextRemoteBrowserPageHandlesByPageId[pageId]
      const nextBrowserAnnotationsByPageId = { ...s.browserAnnotationsByPageId }
      delete nextBrowserAnnotationsByPageId[pageId]
      const nextBrowserCertificateFailuresByPageId = {
        ...s.browserCertificateFailuresByPageId
      }
      delete nextBrowserCertificateFailuresByPageId[pageId]

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
        ),
        remoteBrowserPageHandlesByPageId: nextRemoteBrowserPageHandlesByPageId,
        browserCertificateFailuresByPageId: nextBrowserCertificateFailuresByPageId,
        browserAnnotationsByPageId: nextBrowserAnnotationsByPageId
      }
    })

    for (const remotePage of remotePagesToClose) {
      closeRemoteBrowserPageInOwningEnvironment(remotePage.worktreeId, remotePage.handle)
    }

    const closedWorkspaceId = closedWorkspaceIdForLabel
    if (!closedWorkspaceId) {
      return
    }
    const workspace = findWorkspace(get().browserTabsByWorktree, closedWorkspaceId)
    const item = Object.values(get().unifiedTabsByWorktree)
      .flat()
      .find((entry) => entry.contentType === 'browser' && entry.entityId === closedWorkspaceId)
    if (item && workspace) {
      get().setTabLabel(item.id, workspace.title)
    }
  },

  reopenClosedBrowserPage: (workspaceId) => {
    // Why: read and pop atomically inside set() so two rapid Cmd+Shift+T presses can't both restore the same page (TOCTOU).
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
      activate: true,
      browserRuntimeEnvironmentId: pageToRestore.browserRuntimeEnvironmentId
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

    // Why: switching the active page changes which guest webContents the CDP bridge targets for agent commands.
    const activePage = (get().browserPagesByWorkspace[workspaceId] ?? []).find(
      (page) => page.id === pageId
    )
    const workspace = findWorkspace(get().browserTabsByWorktree, workspaceId)
    if (
      workspace &&
      isLocalBrowserPageOwner(
        get(),
        workspace.worktreeId,
        activePage?.browserRuntimeEnvironmentId
      ) &&
      typeof window !== 'undefined' &&
      window.api?.browser
    ) {
      window.api.browser.notifyActiveTabChanged({ browserPageId: pageId }).catch(() => {})
    }
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
    // Why: bridge targets a browserPageId but tabs activate a workspace; find the owning workspace (they differ for multi-page tabs).
    const tabsForWorktree = get().browserTabsByWorktree[worktreeId] ?? []
    const workspace = tabsForWorktree.find((tab) => (tab.pageIds ?? []).includes(browserPageId))
    if (!workspace) {
      // Best-effort: worktree state may not be hydrated yet, or the page closed between bridge switch and this IPC arriving.
      return
    }
    // Default true: the only caller (tab switch --focus) wants the pane surfaced; false is an opt-out for pre-staging callers.
    const surfacePane = options?.surfacePane ?? true
    const pages = get().browserPagesByWorkspace[workspace.id] ?? []
    const nextWorkspace = mirrorWorkspaceFromActivePage(
      { ...workspace, activePageId: browserPageId },
      pages
    )
    // TODO: duplicates setActiveBrowserTab/Page; can't reuse (they touch globals unconditionally). Extract a per-worktree-only helper.
    set((s) => {
      const isActiveWorktree = s.activeWorktreeId === worktreeId
      // Per-worktree slots: always update — safe pre-staging, only visible when user navigates here.
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
      // Globals: mutate only when the targeted worktree is active — keeps cross-worktree --focus silent.
      return {
        browserTabsByWorktree: nextTabsByWorktree,
        activeBrowserTabIdByWorktree: nextActiveTabIdByWorktree,
        activeTabTypeByWorktree: nextActiveTabTypeByWorktree,
        activeBrowserTabId: isActiveWorktree ? workspace.id : s.activeBrowserTabId,
        activeTabType: isActiveWorktree && surfacePane ? 'browser' : s.activeTabType
      }
    })

    // Why: notify the CDP bridge which guest webContents is active so agent commands target the correct page.
    const focusedPage = pages.find((page) => page.id === browserPageId)
    if (
      isLocalBrowserPageOwner(get(), worktreeId, focusedPage?.browserRuntimeEnvironmentId) &&
      typeof window !== 'undefined' &&
      window.api?.browser
    ) {
      window.api.browser.notifyActiveTabChanged({ browserPageId }).catch(() => {})
    }

    // Why: sync the unified-tab strip's active entry; activateTab only mutates per-worktree slices, so it's cross-worktree-safe.
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
      const nextPage = {
        ...page,
        title:
          updates.title === undefined ? page.title : normalizeBrowserTitle(updates.title, page.url),
        loading: updates.loading ?? page.loading,
        faviconUrl: updates.faviconUrl === undefined ? page.faviconUrl : updates.faviconUrl,
        canGoBack: updates.canGoBack ?? page.canGoBack,
        canGoForward: updates.canGoForward ?? page.canGoForward,
        loadError: updates.loadError === undefined ? page.loadError : updates.loadError
      }
      const unifiedTabs = s.unifiedTabsByWorktree[workspace.worktreeId] ?? []
      const unifiedIndex =
        workspace.activePageId === pageId && updates.title !== undefined
          ? unifiedTabs.findIndex(
              (entry) => entry.contentType === 'browser' && entry.entityId === workspace.id
            )
          : -1
      const unifiedLabelNeedsRepair =
        unifiedIndex !== -1 && unifiedTabs[unifiedIndex]?.label !== nextPage.title
      const pageStateUnchanged =
        nextPage.title === page.title &&
        nextPage.loading === page.loading &&
        nextPage.faviconUrl === page.faviconUrl &&
        nextPage.canGoBack === page.canGoBack &&
        nextPage.canGoForward === page.canGoForward &&
        nextPage.loadError === page.loadError
      const currentPages = s.browserPagesByWorkspace[workspace.id] ?? []
      const mirroredWorkspace = pageStateUnchanged
        ? mirrorWorkspaceFromActivePage(workspace, currentPages)
        : null
      const workspaceNeedsRepair =
        mirroredWorkspace !== null &&
        !browserWorkspaceMirrorFieldsEqual(workspace, mirroredWorkspace)
      if (pageStateUnchanged && !unifiedLabelNeedsRepair && !workspaceNeedsRepair) {
        return s
      }
      if (pageStateUnchanged) {
        const nextState: Partial<AppState> = {}
        if (workspaceNeedsRepair && mirroredWorkspace) {
          nextState.browserTabsByWorktree = {
            ...s.browserTabsByWorktree,
            [workspace.worktreeId]: (s.browserTabsByWorktree[workspace.worktreeId] ?? []).map(
              (tab) => (tab.id === workspace.id ? mirroredWorkspace : tab)
            )
          }
        }
        if (unifiedLabelNeedsRepair) {
          nextState.unifiedTabsByWorktree = {
            ...s.unifiedTabsByWorktree,
            [workspace.worktreeId]: unifiedTabs.map((entry, index) =>
              index === unifiedIndex ? { ...entry, label: nextPage.title } : entry
            )
          }
        }
        return nextState
      }
      const nextPages = currentPages.map((entry) => (entry.id === pageId ? nextPage : entry))
      const nextWorkspace = mirrorWorkspaceFromActivePage(workspace, nextPages)
      const nextState: Partial<AppState> = {
        browserPagesByWorkspace: {
          ...s.browserPagesByWorkspace,
          [workspace.id]: nextPages
        }
      }
      if (!browserWorkspaceMirrorFieldsEqual(workspace, nextWorkspace)) {
        nextState.browserTabsByWorktree = {
          ...s.browserTabsByWorktree,
          [workspace.worktreeId]: (s.browserTabsByWorktree[workspace.worktreeId] ?? []).map((tab) =>
            tab.id === workspace.id ? nextWorkspace : tab
          )
        }
      }
      if (workspace.activePageId === pageId && updates.title !== undefined && unifiedIndex !== -1) {
        if (unifiedLabelNeedsRepair || unifiedTabs[unifiedIndex]?.label !== nextWorkspace.title) {
          nextState.unifiedTabsByWorktree = {
            ...s.unifiedTabsByWorktree,
            [workspace.worktreeId]: unifiedTabs.map((entry, index) =>
              index === unifiedIndex ? { ...entry, label: nextWorkspace.title } : entry
            )
          }
        }
      }
      return nextState
    })
    if (updates.loadError === null) {
      get().setBrowserPageCertificateFailure(pageId, null)
    }
  },

  setBrowserPageCertificateFailure: (pageId, failure) => {
    set((s) => {
      const current = s.browserCertificateFailuresByPageId[pageId]
      if (failure === null) {
        if (!current) {
          return s
        }
        const nextFailures = { ...s.browserCertificateFailuresByPageId }
        delete nextFailures[pageId]
        return { browserCertificateFailuresByPageId: nextFailures }
      }
      if (!findPage(s.browserPagesByWorkspace, pageId) || current === failure) {
        return s
      }
      return {
        browserCertificateFailuresByPageId: {
          ...s.browserCertificateFailuresByPageId,
          [pageId]: failure
        }
      }
    })
  },

  setBrowserTabUrl: (pageId, url) => get().setBrowserPageUrl(pageId, url),

  setBrowserPageUrl: (pageId, url) => {
    const nextUrl = normalizeUrl(url)
    if (nextUrl !== 'about:blank' && nextUrl !== ORCA_BROWSER_BLANK_URL) {
      const currentPage = findPage(get().browserPagesByWorkspace, pageId)
      if (currentPage) {
        get().recordFeatureInteraction?.('browser')
      }
    }
    set((s) => {
      const page = findPage(s.browserPagesByWorkspace, pageId)
      if (!page) {
        return s
      }
      const workspace = findWorkspace(s.browserTabsByWorktree, page.workspaceId)
      if (!workspace) {
        return s
      }
      // Why: annotations point at DOM coords of the loaded document; a real URL change invalidates those markers.
      const shouldClearAnnotations = normalizeUrl(page.url) !== nextUrl
      const nextPages = (s.browserPagesByWorkspace[workspace.id] ?? []).map((entry) =>
        entry.id === pageId
          ? {
              ...entry,
              url: nextUrl,
              title: normalizeBrowserTitle(entry.title, nextUrl),
              loading: true,
              loadError: null
            }
          : entry
      )
      const nextWorkspace = mirrorWorkspaceFromActivePage(workspace, nextPages)
      const nextBrowserAnnotationsByPageId = shouldClearAnnotations
        ? { ...s.browserAnnotationsByPageId }
        : s.browserAnnotationsByPageId
      if (shouldClearAnnotations) {
        delete nextBrowserAnnotationsByPageId[pageId]
      }
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
        ...(shouldClearAnnotations
          ? { browserAnnotationsByPageId: nextBrowserAnnotationsByPageId }
          : {})
      }
    })
    get().setBrowserPageCertificateFailure(pageId, null)
  },

  setRemoteBrowserPageHandle: (pageId, handle) => {
    set((s) => ({
      remoteBrowserPageHandlesByPageId: {
        ...s.remoteBrowserPageHandlesByPageId,
        [pageId]: handle
      }
    }))
  },

  removeRemoteBrowserPageHandle: (pageId, remotePageId) => {
    let removedHandle: RemoteBrowserPageHandle | null = null
    set((s) => {
      const current = s.remoteBrowserPageHandlesByPageId[pageId]
      if (!current || (remotePageId && current.remotePageId !== remotePageId)) {
        return s
      }
      removedHandle = current
      const nextRemoteBrowserPageHandlesByPageId = {
        ...s.remoteBrowserPageHandlesByPageId
      }
      delete nextRemoteBrowserPageHandlesByPageId[pageId]
      return { remoteBrowserPageHandlesByPageId: nextRemoteBrowserPageHandlesByPageId }
    })
    return removedHandle
  },

  // viewportPresetId is intentionally page-local (no workspace-layer UI consumer); do NOT add mirrorWorkspaceFromActivePage here.
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

  addBrowserPageAnnotation: (annotation) =>
    set((s) => {
      const existing = s.browserAnnotationsByPageId[annotation.browserPageId] ?? []
      const next = [...existing, sanitizeBrowserPageAnnotation(annotation)].slice(
        -GRAB_BUDGET.annotationsMaxPerPage
      )
      return {
        browserAnnotationsByPageId: {
          ...s.browserAnnotationsByPageId,
          [annotation.browserPageId]: next
        }
      }
    }),

  deleteBrowserPageAnnotation: (pageId, annotationId) =>
    set((s) => {
      const existing = s.browserAnnotationsByPageId[pageId] ?? []
      const next = existing.filter((annotation) => annotation.id !== annotationId)
      if (next.length === existing.length) {
        return s
      }
      const nextByPageId = { ...s.browserAnnotationsByPageId }
      if (next.length > 0) {
        nextByPageId[pageId] = next
      } else {
        delete nextByPageId[pageId]
      }
      return { browserAnnotationsByPageId: nextByPageId }
    }),

  clearBrowserPageAnnotations: (pageId) =>
    set((s) => {
      if (!s.browserAnnotationsByPageId[pageId]?.length) {
        return s
      }
      const nextByPageId = { ...s.browserAnnotationsByPageId }
      delete nextByPageId[pageId]
      return { browserAnnotationsByPageId: nextByPageId }
    }),

  hydrateBrowserSession: (session, options) => {
    const persistedTabsByWorktree = session.browserTabsByWorktree ?? {}
    const currentState = get()
    const validWorktreeIdsForCleanup = buildValidWorktreeIdsForSessionHydration(
      currentState,
      Object.keys(persistedTabsByWorktree)
    )
    validWorktreeIdsForCleanup.add(FLOATING_TERMINAL_WORKTREE_ID)
    for (const workspace of currentState.folderWorkspaces) {
      validWorktreeIdsForCleanup.add(folderWorkspaceKey(workspace.id))
    }
    addAdditionalValidWorkspaceKeys(validWorktreeIdsForCleanup, options)

    // Why: destroy dropped workspaces' webviews before the pure reducer; no-op today (boot registry empty), defends future re-hydration callers.
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
      const validWorktreeIds = buildValidWorktreeIdsForSessionHydration(
        s,
        Object.keys(persistedTabsByWorktree)
      )
      validWorktreeIds.add(FLOATING_TERMINAL_WORKTREE_ID)
      for (const workspace of s.folderWorkspaces) {
        validWorktreeIds.add(folderWorkspaceKey(workspace.id))
      }
      addAdditionalValidWorkspaceKeys(validWorktreeIds, options)

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
              id: createBrowserUuid(),
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
        remoteBrowserPageHandlesByPageId: {},
        browserCertificateFailuresByPageId: {},
        browserAnnotationsByPageId: {},
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
            label: bt.title,
            recordInteraction: false
          })
        }
      }
    }
  },

  switchBrowserTabProfile: (workspaceId, profileId, sessionPartition) => {
    set((s) => {
      for (const [worktreeId, tabs] of Object.entries(s.browserTabsByWorktree)) {
        const tabIndex = tabs.findIndex((t) => t.id === workspaceId)
        if (tabIndex !== -1) {
          const updatedTabs = [...tabs]
          updatedTabs[tabIndex] = {
            ...updatedTabs[tabIndex],
            sessionProfileId: profileId,
            sessionPartition: sessionPartition ?? null
          }
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
    const hostId = getBrowserSettingsHostId(get())
    const runtimeEnvironmentId = getBrowserSettingsRuntimeEnvironmentId(get())
    if (runtimeEnvironmentId) {
      try {
        const result = await callRuntimeRpc<BrowserProfileListResult>(
          { kind: 'environment', environmentId: runtimeEnvironmentId },
          'browser.profileList',
          undefined,
          { timeoutMs: 15_000 }
        )
        set((s) => profileListByHostUpdate(s, result.profiles, hostId))
      } catch {
        set((s) => profileListByHostUpdate(s, [], hostId))
      }
      return
    }
    try {
      const profiles = (await window.api.browser.sessionListProfiles()) as BrowserSessionProfile[]
      set((s) => profileListByHostUpdate(s, profiles, hostId))
    } catch {
      /* best-effort — stale profile list is preferable to a crash */
    }
  },

  createBrowserSessionProfile: async (scope, label) => {
    const hostId = getBrowserSettingsHostId(get())
    const runtimeEnvironmentId = getBrowserSettingsRuntimeEnvironmentId(get())
    if (runtimeEnvironmentId) {
      try {
        const result = await callRuntimeRpc<BrowserProfileCreateResult>(
          { kind: 'environment', environmentId: runtimeEnvironmentId },
          'browser.profileCreate',
          { scope, label },
          { timeoutMs: 15_000 }
        )
        const profile = result.profile
        if (profile) {
          set((s) => ({
            ...profileListByHostUpdate(
              s,
              [...getBrowserProfilesForHost(s, hostId), profile],
              hostId
            )
          }))
        }
        return profile
      } catch {
        return null
      }
    }
    try {
      const profile = (await window.api.browser.sessionCreateProfile({
        scope,
        label
      })) as BrowserSessionProfile | null
      if (profile) {
        set((s) => ({
          ...profileListByHostUpdate(s, [...getBrowserProfilesForHost(s, hostId), profile], hostId)
        }))
      }
      return profile
    } catch {
      return null
    }
  },

  deleteBrowserSessionProfile: async (profileId) => {
    const hostId = getBrowserSettingsHostId(get())
    const runtimeEnvironmentId = getBrowserSettingsRuntimeEnvironmentId(get())
    if (runtimeEnvironmentId) {
      try {
        const result = await callRuntimeRpc<BrowserProfileDeleteResult>(
          { kind: 'environment', environmentId: runtimeEnvironmentId },
          'browser.profileDelete',
          { profileId },
          { timeoutMs: 15_000 }
        )
        if (result.deleted) {
          set((s) => ({
            ...profileListByHostUpdate(
              s,
              getBrowserProfilesForHost(s, hostId).filter((profile) => profile.id !== profileId),
              hostId
            ),
            ...(getDefaultBrowserProfileForHost(s, hostId) === profileId
              ? {
                  ...(getBrowserSettingsHostId(s) === hostId
                    ? { defaultBrowserSessionProfileId: null }
                    : {}),
                  defaultBrowserSessionProfileIdByHostId: {
                    ...s.defaultBrowserSessionProfileIdByHostId,
                    [hostId]: null
                  }
                }
              : {})
          }))
        }
        return result.deleted
      } catch {
        return false
      }
    }
    try {
      const ok = await window.api.browser.sessionDeleteProfile({ profileId })
      if (ok) {
        set((s) => ({
          ...profileListByHostUpdate(
            s,
            getBrowserProfilesForHost(s, hostId).filter((profile) => profile.id !== profileId),
            hostId
          ),
          ...(getDefaultBrowserProfileForHost(s, hostId) === profileId
            ? {
                ...(getBrowserSettingsHostId(s) === hostId
                  ? { defaultBrowserSessionProfileId: null }
                  : {}),
                defaultBrowserSessionProfileIdByHostId: {
                  ...s.defaultBrowserSessionProfileIdByHostId,
                  [hostId]: null
                }
              }
            : {})
        }))
      }
      return ok
    } catch {
      return false
    }
  },

  importCookiesToProfile: async (profileId) => {
    const hostId = getBrowserSettingsHostId(get())
    if (getBrowserSettingsRuntimeEnvironmentId(get())) {
      const reason = translate(
        'auto.store.slices.browser.remoteCookieImportUnavailable',
        'Manual cookie file import is unavailable while a remote runtime is active.'
      )
      set((state) =>
        browserImportStateForHostUpdate(state, hostId, {
          profileId,
          status: 'error',
          summary: null,
          error: reason
        })
      )
      return { ok: false as const, reason }
    }
    set((state) =>
      browserImportStateForHostUpdate(state, hostId, {
        profileId,
        status: 'importing',
        summary: null,
        error: null
      })
    )
    try {
      const result = (await window.api.browser.sessionImportCookies({
        profileId
      })) as BrowserCookieImportResult
      if (result.ok) {
        get().recordFeatureInteraction?.('cookie-import')
        set((state) =>
          browserImportStateForHostUpdate(state, hostId, {
            profileId,
            status: 'success',
            summary: result.summary,
            error: null
          })
        )
        if (getBrowserSettingsHostId(get()) === hostId) {
          await get()
            .fetchBrowserSessionProfiles()
            .catch(() => {})
        }
      } else {
        set((state) =>
          browserImportStateForHostUpdate(state, hostId, {
            profileId,
            status: result.reason === 'canceled' ? 'idle' : 'error',
            summary: null,
            error: result.reason === 'canceled' ? null : result.reason
          })
        )
      }
      return result
    } catch (err) {
      const reason = String((err as Error)?.message ?? err)
      set((state) =>
        browserImportStateForHostUpdate(state, hostId, {
          profileId,
          status: 'error',
          summary: null,
          error: reason
        })
      )
      return { ok: false as const, reason }
    }
  },

  clearBrowserSessionImportState: () => {
    set({ browserSessionImportState: null })
  },

  detectedBrowsers: [],
  detectedBrowsersLoaded: false,

  fetchDetectedBrowsers: async () => {
    const hostId = getBrowserSettingsHostId(get())
    const runtimeEnvironmentId = getBrowserSettingsRuntimeEnvironmentId(get())
    if (runtimeEnvironmentId) {
      try {
        const result = await callRuntimeRpc<BrowserDetectProfilesResult>(
          { kind: 'environment', environmentId: runtimeEnvironmentId },
          'browser.profileDetectBrowsers',
          undefined,
          { timeoutMs: 15_000 }
        )
        set((s) =>
          getBrowserSettingsHostId(s) === hostId
            ? { detectedBrowsers: result.browsers, detectedBrowsersLoaded: true }
            : {}
        )
      } catch {
        set((s) =>
          getBrowserSettingsHostId(s) === hostId
            ? { detectedBrowsers: [], detectedBrowsersLoaded: true }
            : {}
        )
      }
      return
    }
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
      set((s) =>
        getBrowserSettingsHostId(s) === hostId
          ? { detectedBrowsers: browsers, detectedBrowsersLoaded: true }
          : {}
      )
    } catch {
      /* best-effort — empty list is acceptable fallback */
      set((s) => (getBrowserSettingsHostId(s) === hostId ? { detectedBrowsersLoaded: true } : {}))
    }
  },

  importCookiesFromBrowser: async (profileId, browserFamily, browserProfile?) => {
    const hostId = getBrowserSettingsHostId(get())
    const runtimeEnvironmentId = getBrowserSettingsRuntimeEnvironmentId(get())
    if (runtimeEnvironmentId) {
      set((state) =>
        browserImportStateForHostUpdate(state, hostId, {
          profileId,
          status: 'importing',
          summary: null,
          error: null
        })
      )
      try {
        const result = await callRuntimeRpc<BrowserProfileImportFromBrowserResult>(
          { kind: 'environment', environmentId: runtimeEnvironmentId },
          'browser.profileImportFromBrowser',
          { profileId, browserFamily, browserProfile },
          { timeoutMs: 30_000 }
        )
        if (result.ok) {
          set((state) =>
            browserImportStateForHostUpdate(state, hostId, {
              profileId,
              status: 'success',
              summary: result.summary,
              error: null
            })
          )
          if (getBrowserSettingsHostId(get()) === hostId) {
            await get()
              .fetchBrowserSessionProfiles()
              .catch(() => {})
          }
        } else {
          set((state) =>
            browserImportStateForHostUpdate(state, hostId, {
              profileId,
              status: 'error',
              summary: null,
              error: result.reason
            })
          )
        }
        return result
      } catch (err) {
        const reason = String((err as Error)?.message ?? err)
        set((state) =>
          browserImportStateForHostUpdate(state, hostId, {
            profileId,
            status: 'error',
            summary: null,
            error: reason
          })
        )
        return { ok: false as const, reason }
      }
    }
    set((state) =>
      browserImportStateForHostUpdate(state, hostId, {
        profileId,
        status: 'importing',
        summary: null,
        error: null
      })
    )
    try {
      const result = (await window.api.browser.sessionImportFromBrowser({
        profileId,
        browserFamily,
        browserProfile
      })) as BrowserCookieImportResult
      if (result.ok) {
        get().recordFeatureInteraction?.('cookie-import')
        set((state) =>
          browserImportStateForHostUpdate(state, hostId, {
            profileId,
            status: 'success',
            summary: result.summary,
            error: null
          })
        )
        if (getBrowserSettingsHostId(get()) === hostId) {
          await get()
            .fetchBrowserSessionProfiles()
            .catch(() => {})
        }
      } else {
        set((state) =>
          browserImportStateForHostUpdate(state, hostId, {
            profileId,
            status: 'error',
            summary: null,
            error: result.reason
          })
        )
      }
      return result
    } catch (err) {
      const reason = String((err as Error)?.message ?? err)
      set((state) =>
        browserImportStateForHostUpdate(state, hostId, {
          profileId,
          status: 'error',
          summary: null,
          error: reason
        })
      )
      return { ok: false as const, reason }
    }
  },

  clearDefaultSessionCookies: async () => {
    const hostId = getBrowserSettingsHostId(get())
    const runtimeEnvironmentId = getBrowserSettingsRuntimeEnvironmentId(get())
    if (runtimeEnvironmentId) {
      try {
        const result = await callRuntimeRpc<BrowserProfileClearDefaultCookiesResult>(
          { kind: 'environment', environmentId: runtimeEnvironmentId },
          'browser.profileClearDefaultCookies',
          undefined,
          { timeoutMs: 15_000 }
        )
        if (result.cleared && getBrowserSettingsHostId(get()) === hostId) {
          await get().fetchBrowserSessionProfiles()
        }
        return result.cleared
      } catch {
        return false
      }
    }
    try {
      const ok = await window.api.browser.sessionClearDefaultCookies()
      if (ok && getBrowserSettingsHostId(get()) === hostId) {
        get().recordFeatureInteraction?.('cookie-import')
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
