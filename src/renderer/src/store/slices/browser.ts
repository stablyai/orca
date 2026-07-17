/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  BrowserCookieImportScope,
  BrowserCookieImportResult,
  BrowserCookieImportSummary,
  BrowserCertificateFailure,
  BrowserHistoryEntry,
  BrowserLoadError,
  BrowserPage,
  BrowserSessionProfile,
  BrowserViewportPresetId,
  BrowserWorkspace,
  WebAiAccount,
  WebAiProvider,
  WorkspaceSessionState
} from '../../../../shared/types'
import { GRAB_BUDGET, type BrowserPageAnnotation } from '../../../../shared/browser-grab-types'
import {
  FLOATING_TERMINAL_WORKTREE_ID,
  ORCA_BROWSER_BLANK_URL,
  PERSISTENT_LOCAL_WORKSPACE_IDS
} from '../../../../shared/constants'
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
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
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
import {
  getWebAiAccountWorkspaceId,
  getWebAiAccountHomeUrl,
  isWebAiAccountWorkspaceId,
  isWebAiBrowserWorkspaceId,
  normalizeWebAiAccounts,
  parseWebAiAccountWorkspaceId,
  webAiAccountMatchesBinding,
  webAiAccountMatchesWorkspace
} from '../../../../shared/web-ai-accounts'
import type { BrowserProfileOperationOwner } from '@/lib/browser-profile-operation-owner'

type CreateBrowserTabOptions = {
  activate?: boolean
  title?: string
  sessionProfileId?: string | null
  sessionPartition?: string | null
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
  browserRuntimeEnvironmentId?: string | null
  webAiAccountId?: string | null
}

type CreateBrowserPageOptions = {
  activate?: boolean
  title?: string
  browserRuntimeEnvironmentId?: string | null
}

export type WebAiAccountLaunchResult =
  | { ok: true; workspace: BrowserWorkspace; profiles: BrowserSessionProfile[] }
  | {
      ok: false
      reason: 'profile-check-failed'
      profiles: null
    }
  | {
      ok: false
      reason: 'profile-missing' | 'launch-failed'
      profiles: BrowserSessionProfile[]
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
      // Why: annotations live in persisted renderer state; screenshots are
      // transient copy payloads and can retain megabytes per note.
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
  openBrowserLinkInNewTab: (sourcePageId: string, url: string) => BrowserWorkspace | null
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
  browserSessionImportState: {
    profileId: string
    status: 'idle' | 'importing' | 'success' | 'error'
    summary: BrowserCookieImportSummary | null
    error: string | null
  } | null
  fetchBrowserSessionProfiles: (owner?: BrowserProfileOperationOwner) => Promise<void>
  createBrowserSessionProfile: (
    scope: 'isolated' | 'imported',
    label: string
  ) => Promise<BrowserSessionProfile | null>
  deleteBrowserSessionProfile: (profileId: string) => Promise<boolean>
  importCookiesToProfile: (
    profileId: string,
    webAiProvider?: WebAiProvider,
    cookieImportScope?: BrowserCookieImportScope,
    owner?: BrowserProfileOperationOwner
  ) => Promise<BrowserCookieImportResult>
  clearBrowserSessionImportState: () => void
  detectedBrowsers: {
    family: string
    label: string
    profiles: { name: string; directory: string }[]
    selectedProfile: string
  }[]
  detectedBrowsersLoaded: boolean
  detectedBrowsersHostId: ExecutionHostId | null
  detectedBrowsersRequestGeneration: number
  fetchDetectedBrowsers: (owner?: BrowserProfileOperationOwner) => Promise<void>
  importCookiesFromBrowser: (
    profileId: string,
    browserFamily: string,
    browserProfile?: string,
    webAiProvider?: WebAiProvider,
    cookieImportScope?: BrowserCookieImportScope,
    owner?: BrowserProfileOperationOwner
  ) => Promise<BrowserCookieImportResult>
  clearDefaultSessionCookies: () => Promise<boolean>
  browserUrlHistory: BrowserHistoryEntry[]
  addBrowserHistoryEntry: (url: string, title: string) => void
  clearBrowserHistory: () => void
  defaultBrowserSessionProfileId: string | null
  defaultBrowserSessionProfileIdByHostId: Partial<Record<ExecutionHostId, string | null>>
  setDefaultBrowserSessionProfileId: (profileId: string | null) => void
  openWebAiAccount: (
    account: WebAiAccount,
    options?: {
      openNewTab?: boolean
      targetGroupId?: string
      url?: string
      title?: string
      activate?: boolean
      targetWorktreeId?: string
    }
  ) => BrowserWorkspace | null
  launchWebAiAccount: (
    account: WebAiAccount,
    options?: {
      openNewTab?: boolean
      targetGroupId?: string
      url?: string
      title?: string
      activate?: boolean
      targetWorktreeId?: string
    }
  ) => Promise<WebAiAccountLaunchResult>
  activateWebAiBrowserWorkspace: (
    accountWorkspaceId: string,
    browserWorkspaceId?: string
  ) => boolean
  deleteWebAiAccount: (accountId: string) => Promise<boolean>
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

function isRuntimeEnvironmentActive(state: AppState): boolean {
  return Boolean(state.settings?.activeRuntimeEnvironmentId?.trim())
}

function getBrowserSettingsHostId(state: Pick<AppState, 'settings'>): ExecutionHostId {
  return getSettingsFocusedExecutionHostId(state.settings)
}

function getBrowserProfileOperationRuntimeEnvironmentId(
  state: Pick<AppState, 'settings'>,
  owner?: BrowserProfileOperationOwner
): string | null {
  if (owner) {
    return owner.runtimeEnvironmentId?.trim() || null
  }
  return state.settings?.activeRuntimeEnvironmentId?.trim() || null
}

function getBrowserProfileOperationHostId(
  state: Pick<AppState, 'settings'>,
  owner?: BrowserProfileOperationOwner
): ExecutionHostId {
  const runtimeEnvironmentId = getBrowserProfileOperationRuntimeEnvironmentId(state, owner)
  return runtimeEnvironmentId
    ? toRuntimeExecutionHostId(runtimeEnvironmentId)
    : LOCAL_EXECUTION_HOST_ID
}

function getBrowserProfileOperationRuntimeTarget(
  state: Pick<AppState, 'settings'>,
  owner?: BrowserProfileOperationOwner
): RuntimeClientTarget | null {
  const host = parseExecutionHostId(getBrowserProfileOperationHostId(state, owner))
  return host?.kind === 'runtime'
    ? { kind: 'environment', environmentId: host.environmentId }
    : null
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

function profileListByHostUpdate(
  state: Pick<AppState, 'browserSessionProfilesByHostId' | 'settings'>,
  profiles: BrowserSessionProfile[],
  hostId: ExecutionHostId = getBrowserSettingsHostId(state)
): Partial<BrowserSlice> {
  const hostProfiles = {
    browserSessionProfilesByHostId: {
      ...state.browserSessionProfilesByHostId,
      [hostId]: profiles
    }
  }
  return hostId === getBrowserSettingsHostId(state)
    ? { ...hostProfiles, browserSessionProfiles: profiles }
    : hostProfiles
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
    // Why: blank pages mount an inert guest first. Treating them as loading
    // would make an empty workspace flash the global loading affordance even
    // though no real navigation happened yet.
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
  sessionPartition?: string | null,
  webAiAccountId?: string | null
): BrowserWorkspace {
  return {
    id,
    worktreeId,
    sessionProfileId: sessionProfileId ?? null,
    sessionPartition: sessionPartition ?? null,
    webAiAccountId: webAiAccountId ?? null,
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

function findWebAiAccountWorkspaces(
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>,
  accountId: string
): BrowserWorkspace[] {
  return Object.values(browserTabsByWorktree)
    .flat()
    .filter((entry) => entry.webAiAccountId === accountId)
}

function webAiAccountWorkspaceBindingIsValid(
  account: WebAiAccount,
  workspace: BrowserWorkspace
): boolean {
  if (!webAiAccountMatchesBinding(account, workspace)) {
    return false
  }
  return !isWebAiBrowserWorkspaceId(workspace.worktreeId)
    ? true
    : webAiAccountMatchesWorkspace(account, workspace)
}

function canPlaceWebAiAccountInWorktree(
  state: AppState,
  account: WebAiAccount,
  worktreeId: string
): boolean {
  const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)
  if (worktreeId === accountWorkspaceId) {
    return true
  }
  if (
    isWebAiBrowserWorkspaceId(worktreeId) ||
    typeof state.getKnownWorktreeById !== 'function' ||
    !state.getKnownWorktreeById(worktreeId)
  ) {
    return false
  }
  // Why: account profiles belong to the desktop Electron session. A runtime
  // worktree's browser tabs are owned by its remote runtime, so mixing the two
  // would split one tab group across hosts and risk publishing private state.
  return getRuntimeEnvironmentIdForWorktree(state, worktreeId) === null
}

function findPreferredWebAiAccountWorkspaceInWorktree(
  state: AppState,
  workspaces: readonly BrowserWorkspace[],
  worktreeId: string
): BrowserWorkspace | null {
  const inWorktree = workspaces.filter((workspace) => workspace.worktreeId === worktreeId)
  const preferredId = state.activeBrowserTabIdByWorktree[worktreeId]
  return inWorktree.find((workspace) => workspace.id === preferredId) ?? inWorktree[0] ?? null
}

function findMostRecentlyVisitedWebAiAccountWorkspace(
  state: AppState,
  workspaces: readonly BrowserWorkspace[]
): BrowserWorkspace | null {
  const history = state.worktreeNavHistory ?? []
  const lastHistoryIndex = Math.min(
    state.worktreeNavHistoryIndex ?? history.length - 1,
    history.length - 1
  )
  for (let index = lastHistoryIndex; index >= 0; index -= 1) {
    const entry = history[index]
    if (typeof entry !== 'string') {
      continue
    }
    const workspace = findPreferredWebAiAccountWorkspaceInWorktree(state, workspaces, entry)
    if (workspace) {
      return workspace
    }
  }
  return (
    [...workspaces]
      .sort((left, right) => right.createdAt - left.createdAt)
      .find(
        (workspace) => state.activeBrowserTabIdByWorktree[workspace.worktreeId] === workspace.id
      ) ??
    [...workspaces].sort((left, right) => right.createdAt - left.createdAt)[0] ??
    null
  )
}

function activateWebAiAccountWorkspace(
  get: () => AppState,
  worktreeId: string,
  browserWorkspaceId?: string
): boolean {
  const state = get()
  const workspaces = state.browserTabsByWorktree[worktreeId] ?? []
  const preferredWorkspaceId = browserWorkspaceId ?? state.activeBrowserTabIdByWorktree[worktreeId]
  const workspace =
    workspaces.find((entry) => entry.id === preferredWorkspaceId) ?? workspaces[0] ?? null
  if (!workspace) {
    return false
  }

  const alreadyVisible =
    state.activeView === 'terminal' &&
    state.activeWorktreeId === worktreeId &&
    state.activeTabType === 'browser' &&
    state.activeBrowserTabId === workspace.id
  const switchingWorktree = state.activeWorktreeId !== worktreeId
  state.setActiveView('terminal')
  if (switchingWorktree) {
    state.setActiveWorktree(worktreeId)
  }
  state.setActiveBrowserTab(workspace.id)
  if (!alreadyVisible && switchingWorktree && !state.isNavigatingHistory) {
    state.recordWorktreeVisit(worktreeId)
  }
  return true
}

function removeStaleWebAiAccountWorkspaces(get: () => AppState, account: WebAiAccount): void {
  const staleWorkspaces = findWebAiAccountWorkspaces(
    get().browserTabsByWorktree,
    account.id
  ).filter(
    (workspace) =>
      !webAiAccountWorkspaceBindingIsValid(account, workspace) ||
      !canPlaceWebAiAccountInWorktree(get(), account, workspace.worktreeId)
  )
  for (const staleWorkspace of staleWorkspaces) {
    // Why: an untagged old-profile tab inside the synthetic account workspace
    // would still be reachable through the account-scoped tab shortcuts.
    destroyWorkspaceWebviews(get().browserPagesByWorkspace, staleWorkspace.id)
    get().closeBrowserTab(staleWorkspace.id)
  }
}

function legacyWebAiSiblingWorkspaceId(sourceWorkspaceId: string, pageId: string): string {
  // Length-prefix both components so even malformed legacy IDs cannot produce
  // the same migration ID through delimiter ambiguity.
  return `legacy-web-ai-workspace:${sourceWorkspaceId.length}:${sourceWorkspaceId}:${pageId.length}:${pageId}`
}

function legacyWebAiSiblingUnifiedTabId(workspaceId: string): string {
  return `legacy-web-ai-tab:${workspaceId.length}:${workspaceId}`
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
  browserSessionImportState: null,
  browserUrlHistory: [],
  defaultBrowserSessionProfileId: null,
  defaultBrowserSessionProfileIdByHostId: {},

  setDefaultBrowserSessionProfileId: (profileId) => {
    set((s) => ({
      defaultBrowserSessionProfileId: profileId,
      defaultBrowserSessionProfileIdByHostId: {
        ...s.defaultBrowserSessionProfileIdByHostId,
        [getBrowserSettingsHostId(s)]: profileId
      }
    }))
  },

  launchWebAiAccount: async (account, options) => {
    let profiles: BrowserSessionProfile[]
    try {
      profiles = (await window.api.browser.sessionListProfiles()) as BrowserSessionProfile[]
    } catch {
      return { ok: false, reason: 'profile-check-failed', profiles: null }
    }
    set((state) => profileListByHostUpdate(state, profiles, LOCAL_EXECUTION_HOST_ID))
    // Why: UI callbacks can outlive settings changes; only the current saved
    // account binding may select the cookie partition used for launch.
    const canonicalAccount = normalizeWebAiAccounts(get().settings?.webAiAccounts).find(
      (entry) => entry.id === account.id
    )
    if (!canonicalAccount) {
      return { ok: false, reason: 'launch-failed', profiles }
    }
    removeStaleWebAiAccountWorkspaces(get, canonicalAccount)
    const profileExists = profiles.some(
      (profile) =>
        profile.scope !== 'default' &&
        profile.id === canonicalAccount.profileId &&
        profile.partition === canonicalAccount.sessionPartition
    )
    if (!profileExists) {
      return { ok: false, reason: 'profile-missing', profiles }
    }
    const workspace = get().openWebAiAccount(canonicalAccount, options)
    return workspace
      ? { ok: true, workspace, profiles }
      : { ok: false, reason: 'launch-failed', profiles }
  },

  openWebAiAccount: (account, options) => {
    // V1 binds saved web identities to the desktop Electron browser. A later
    // runtime implementation can route through browser.tabCreate without
    // changing the persisted account model.
    if (account.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
      return null
    }
    const accountHomeUrl = getWebAiAccountHomeUrl(account)
    if (!accountHomeUrl) {
      return null
    }
    const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)
    removeStaleWebAiAccountWorkspaces(get, account)
    const state = get()
    const taggedWorkspaces = findWebAiAccountWorkspaces(get().browserTabsByWorktree, account.id)
    const validWorkspaces = taggedWorkspaces.filter((workspace) =>
      webAiAccountWorkspaceBindingIsValid(account, workspace)
    )
    const requestedTargetWorktreeId = options?.targetWorktreeId
    if (
      requestedTargetWorktreeId &&
      !canPlaceWebAiAccountInWorktree(state, account, requestedTargetWorktreeId)
    ) {
      return null
    }
    const activeTargetWorktreeId =
      state.activeWorktreeId &&
      canPlaceWebAiAccountInWorktree(state, account, state.activeWorktreeId)
        ? state.activeWorktreeId
        : null
    const existing = options?.openNewTab
      ? null
      : requestedTargetWorktreeId
        ? findPreferredWebAiAccountWorkspaceInWorktree(
            state,
            validWorkspaces,
            requestedTargetWorktreeId
          )
        : ((activeTargetWorktreeId
            ? findPreferredWebAiAccountWorkspaceInWorktree(
                state,
                validWorkspaces,
                activeTargetWorktreeId
              )
            : null) ?? findMostRecentlyVisitedWebAiAccountWorkspace(state, validWorkspaces))
    if (existing && !options?.openNewTab) {
      activateWebAiAccountWorkspace(get, existing.worktreeId, existing.id)
      return findWorkspace(get().browserTabsByWorktree, existing.id) ?? existing
    }

    const targetWorktreeId =
      requestedTargetWorktreeId ?? activeTargetWorktreeId ?? accountWorkspaceId
    const created = get().createBrowserTab(targetWorktreeId, options?.url ?? accountHomeUrl, {
      activate: options?.activate ?? true,
      title: options?.title ?? account.label,
      sessionProfileId: account.profileId,
      sessionPartition: account.sessionPartition,
      targetGroupId: options?.targetGroupId,
      browserRuntimeEnvironmentId: null,
      webAiAccountId: account.id
    })
    if (options?.activate !== false) {
      activateWebAiAccountWorkspace(get, targetWorktreeId, created.id)
    }
    return findWorkspace(get().browserTabsByWorktree, created.id) ?? created
  },

  activateWebAiBrowserWorkspace: (accountWorkspaceId, browserWorkspaceId) => {
    if (!isWebAiAccountWorkspaceId(accountWorkspaceId)) {
      return false
    }
    return activateWebAiAccountWorkspace(get, accountWorkspaceId, browserWorkspaceId)
  },

  deleteWebAiAccount: async (accountId) => {
    const accounts = normalizeWebAiAccounts(get().settings?.webAiAccounts)
    await get().updateSettings({
      webAiAccounts: accounts.filter((account) => account.id !== accountId)
    })
    if (
      normalizeWebAiAccounts(get().settings?.webAiAccounts).some((entry) => entry.id === accountId)
    ) {
      return false
    }
    const workspaces = findWebAiAccountWorkspaces(get().browserTabsByWorktree, accountId)
    for (const workspace of workspaces) {
      destroyWorkspaceWebviews(get().browserPagesByWorkspace, workspace.id)
      get().closeBrowserTab(workspace.id)
    }
    set((state) => {
      const recentlyClosedBrowserTabsByWorktree: Record<string, ClosedBrowserWorkspaceSnapshot[]> =
        {}
      for (const [worktreeId, snapshots] of Object.entries(
        state.recentlyClosedBrowserTabsByWorktree
      )) {
        const retained = snapshots.filter(
          (snapshot) => snapshot.workspace.webAiAccountId !== accountId
        )
        if (retained.length > 0) {
          recentlyClosedBrowserTabsByWorktree[worktreeId] = retained
        }
      }
      return { recentlyClosedBrowserTabsByWorktree }
    })
    return true
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
    // Why: when no explicit profile is passed, inherit the user's chosen default
    // profile. This lets users set a preferred profile in Settings that all new
    // browser tabs use automatically.
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
      options?.sessionPartition,
      options?.webAiAccountId
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
    if (isWebAiAccountWorkspaceId(worktreeId)) {
      const accountId = parseWebAiAccountWorkspaceId(worktreeId)
      const account = accountId
        ? normalizeWebAiAccounts(state.settings?.webAiAccounts).find(
            (entry) => entry.id === accountId
          )
        : null
      if (account) {
        await get().launchWebAiAccount(account, {
          openNewTab: true,
          targetGroupId: groupId
        })
      }
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
        // Why: a remote-owned workspace must NOT silently fall back to a local
        // desktop browser tab — that creates confusing split ownership. Headless
        // remotes that support browser panes advertise browser.headless.v1 and
        // succeed above; if creation fails, surface it instead of going local.
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
  openBrowserLinkInNewTab: (sourcePageId, url) => {
    const state = get()
    const sourcePage = findPage(state.browserPagesByWorkspace, sourcePageId)
    if (!sourcePage) {
      return null
    }
    const sourceWorkspace = findWorkspace(state.browserTabsByWorktree, sourcePage.workspaceId)
    if (!sourceWorkspace) {
      return null
    }
    const sourceUnifiedTab = (state.unifiedTabsByWorktree[sourcePage.worktreeId] ?? []).find(
      (tab) => tab.contentType === 'browser' && tab.entityId === sourceWorkspace.id
    )
    const account = sourceWorkspace.webAiAccountId
      ? normalizeWebAiAccounts(state.settings?.webAiAccounts).find((entry) =>
          webAiAccountMatchesBinding(entry, sourceWorkspace)
        )
      : null
    if (sourceWorkspace.webAiAccountId) {
      return account
        ? get().openWebAiAccount(account, {
            openNewTab: true,
            targetGroupId: sourceUnifiedTab?.groupId,
            targetWorktreeId: sourcePage.worktreeId,
            url,
            title: url
          })
        : null
    }
    if (isWebAiAccountWorkspaceId(sourcePage.worktreeId)) {
      return null
    }
    return get().createBrowserTab(sourcePage.worktreeId, url, {
      title: url,
      sessionProfileId: sourceWorkspace.sessionProfileId,
      sessionPartition: sourceWorkspace.sessionPartition,
      targetGroupId: sourceUnifiedTab?.groupId,
      browserRuntimeEnvironmentId: sourcePage.browserRuntimeEnvironmentId ?? null
    })
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
    const activeWorktreeId = get().activeWorktreeId
    if (
      activeWorktreeId &&
      isWebAiAccountWorkspaceId(activeWorktreeId) &&
      (get().browserTabsByWorktree[activeWorktreeId]?.length ?? 0) === 0
    ) {
      get().setActiveWorktree(null)
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
    const sessionPartition = snap.sessionPartition ?? null
    const savedAccount = snap.webAiAccountId
      ? normalizeWebAiAccounts(get().settings?.webAiAccounts).find((account) =>
          webAiAccountWorkspaceBindingIsValid(account, snap)
        )
      : null
    const webAiAccountId = savedAccount?.id ?? null

    // Why: never reopen an account-tagged snapshot after its canonical account,
    // profile, partition, or placement changed. Restoring it as an ordinary tab
    // would silently retain access to the old authenticated partition.
    if (
      (snap.webAiAccountId && !savedAccount) ||
      (savedAccount && !canPlaceWebAiAccountInWorktree(get(), savedAccount, worktreeId)) ||
      (isWebAiAccountWorkspaceId(worktreeId) && !savedAccount)
    ) {
      return null
    }

    if (pages.length === 0) {
      const restored = get().createBrowserTab(worktreeId, snap.url, {
        title: snap.title,
        activate: true,
        sessionProfileId,
        sessionPartition,
        webAiAccountId
      })
      return get().browserTabsByWorktree[worktreeId]?.find((tab) => tab.id === restored.id) ?? null
    }

    // Why: create the tab with the first page, then append the rest in
    // original order so multi-page workspaces preserve their page sequence.
    const [firstPage, ...restPages] = pages
    const restored = get().createBrowserTab(worktreeId, firstPage.url, {
      title: firstPage.title,
      activate: true,
      sessionProfileId,
      sessionPartition,
      webAiAccountId,
      browserRuntimeEnvironmentId: savedAccount ? null : firstPage.browserRuntimeEnvironmentId
    })

    for (const p of restPages) {
      get().createBrowserPage(restored.id, p.url, {
        activate: false,
        title: p.title,
        browserRuntimeEnvironmentId: savedAccount ? null : p.browserRuntimeEnvironmentId
      })
    }

    // Why: duplicate URLs are valid browser pages; restoring by URL can select
    // the wrong copy. The restore path preserves page order, so map by index.
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

    // Why: notify the CDP bridge which guest webContents is now active so
    // subsequent agent commands (snapshot, click, etc.) target the correct tab.
    // registerGuest uses page IDs (not workspace IDs), so we resolve the active
    // page within the workspace to find the correct browserPageId.
    const workspace = findWorkspace(get().browserTabsByWorktree, tabId)
    if (
      workspace?.activePageId &&
      !isRuntimeEnvironmentActive(get()) &&
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

    // Why: switching the active page within a workspace changes which guest
    // webContents the CDP bridge should target for agent commands.
    if (
      !isRuntimeEnvironmentActive(get()) &&
      typeof window !== 'undefined' &&
      window.api?.browser
    ) {
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
    if (
      !isRuntimeEnvironmentActive(get()) &&
      typeof window !== 'undefined' &&
      window.api?.browser
    ) {
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
      // Why: annotations point at DOM coordinates from one loaded document.
      // A real URL change invalidates those markers and copied context.
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
    const persistedPagesByWorkspace = session.browserPagesByWorkspace ?? {}
    const legacyWebAiMigrationBySourceWorkspaceId = new Map<
      string,
      {
        worktreeId: string
        workspaceIdByPageId: Map<string, string>
        workspaceIdsInPageOrder: string[]
      }
    >()
    const legacyWebAiSiblingSourceByWorkspaceId = new Map<
      string,
      { sourceWorkspaceId: string; worktreeId: string }
    >()
    for (const [worktreeId, tabs] of Object.entries(persistedTabsByWorktree)) {
      if (!isWebAiAccountWorkspaceId(worktreeId)) {
        continue
      }
      for (const tab of tabs) {
        const pages = persistedPagesByWorkspace[tab.id] ?? []
        if (pages.length <= 1) {
          continue
        }
        const primaryPageId = pages.some((page) => page.id === tab.activePageId)
          ? tab.activePageId
          : pages[0]?.id
        const workspaceIdByPageId = new Map<string, string>()
        const workspaceIdsInPageOrder = pages.map((page) => {
          const workspaceId =
            page.id === primaryPageId ? tab.id : legacyWebAiSiblingWorkspaceId(tab.id, page.id)
          workspaceIdByPageId.set(page.id, workspaceId)
          if (workspaceId !== tab.id) {
            legacyWebAiSiblingSourceByWorkspaceId.set(workspaceId, {
              sourceWorkspaceId: tab.id,
              worktreeId
            })
          }
          return workspaceId
        })
        legacyWebAiMigrationBySourceWorkspaceId.set(tab.id, {
          worktreeId,
          workspaceIdByPageId,
          workspaceIdsInPageOrder
        })
      }
    }
    const currentState = get()
    const savedWebAiAccountById = new Map(
      normalizeWebAiAccounts(currentState.settings?.webAiAccounts).map((account) => [
        account.id,
        account
      ])
    )
    const validWorktreeIdsForCleanup = new Set(
      Object.values(currentState.worktreesByRepo)
        .flat()
        .map((worktree) => worktree.id)
    )
    for (const workspaceId of PERSISTENT_LOCAL_WORKSPACE_IDS) {
      validWorktreeIdsForCleanup.add(workspaceId)
    }
    for (const account of savedWebAiAccountById.values()) {
      validWorktreeIdsForCleanup.add(getWebAiAccountWorkspaceId(account.id))
    }
    for (const workspace of currentState.folderWorkspaces) {
      validWorktreeIdsForCleanup.add(folderWorkspaceKey(workspace.id))
    }
    addAdditionalValidWorkspaceKeys(validWorktreeIdsForCleanup, options)

    // Why: mirror closeBrowserTab's contract — reducers are pure, imperative
    // side effects bracket them. Compute dropped workspaces first, destroy
    // their webviews, then run the state reducer unchanged. hydrate is called
    // once at boot (App.tsx) when the webview registry is empty, so this loop
    // is a no-op today; it's defense-in-depth for any future caller that
    // re-hydrates after webviews are live.
    const droppedWorkspaceIds: string[] = []
    for (const [worktreeId, tabs] of Object.entries(persistedTabsByWorktree)) {
      for (const tab of tabs) {
        const savedAccount = tab.webAiAccountId
          ? savedWebAiAccountById.get(tab.webAiAccountId)
          : undefined
        const invalidWebAiBinding = tab.webAiAccountId
          ? !savedAccount ||
            !webAiAccountWorkspaceBindingIsValid(savedAccount, tab) ||
            !canPlaceWebAiAccountInWorktree(currentState, savedAccount, worktreeId)
          : isWebAiBrowserWorkspaceId(worktreeId)
        if (!validWorktreeIdsForCleanup.has(worktreeId) || invalidWebAiBinding) {
          droppedWorkspaceIds.push(tab.id)
        }
      }
    }
    for (const workspaceId of droppedWorkspaceIds) {
      destroyWorkspaceWebviews(currentState.browserPagesByWorkspace, workspaceId)
    }

    set((s) => {
      const persistedActiveBrowserTabIdByWorktree = session.activeBrowserTabIdByWorktree ?? {}
      const persistedActiveTabTypeByWorktree = session.activeTabTypeByWorktree ?? {}
      const validWorktreeIds = new Set(
        Object.values(s.worktreesByRepo)
          .flat()
          .map((worktree) => worktree.id)
      )
      for (const workspaceId of PERSISTENT_LOCAL_WORKSPACE_IDS) {
        validWorktreeIds.add(workspaceId)
      }
      for (const workspace of s.folderWorkspaces) {
        validWorktreeIds.add(folderWorkspaceKey(workspace.id))
      }
      addAdditionalValidWorkspaceKeys(validWorktreeIds, options)

      const browserTabsByWorktree: Record<string, BrowserWorkspace[]> = {}
      const browserPagesByWorkspace: Record<string, BrowserPage[]> = {}
      const currentWebAiAccountById = new Map(
        normalizeWebAiAccounts(s.settings?.webAiAccounts).map((account) => [account.id, account])
      )
      for (const account of currentWebAiAccountById.values()) {
        validWorktreeIds.add(getWebAiAccountWorkspaceId(account.id))
      }

      for (const [worktreeId, tabs] of Object.entries(persistedTabsByWorktree)) {
        if (!validWorktreeIds.has(worktreeId)) {
          continue
        }
        const hydratedTabs: BrowserWorkspace[] = []
        for (const tab of tabs) {
          const savedAccount = tab.webAiAccountId
            ? currentWebAiAccountById.get(tab.webAiAccountId)
            : undefined
          const invalidWebAiBinding = tab.webAiAccountId
            ? !savedAccount ||
              !webAiAccountWorkspaceBindingIsValid(savedAccount, tab) ||
              !canPlaceWebAiAccountInWorktree(s, savedAccount, worktreeId)
            : isWebAiBrowserWorkspaceId(worktreeId)
          if (invalidWebAiBinding) {
            continue
          }
          const persistedPages = persistedPagesByWorkspace[tab.id] ?? [
            {
              id: createBrowserUuid(),
              workspaceId: tab.id,
              worktreeId,
              url: normalizeUrl(tab.url),
              title: tab.title,
              loading: false,
              faviconUrl: tab.faviconUrl ?? null,
              canGoBack: false,
              canGoForward: false,
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
            // Why: guest webContents are recreated after restart, so their
            // Chromium navigation stacks do not survive the session payload.
            canGoBack: false,
            canGoForward: false,
            loadError: page.loadError ?? null
          }))

          if (isWebAiAccountWorkspaceId(worktreeId) && nextPages.length > 1) {
            // Early development builds stored sidebar "+" pages inside one
            // BrowserWorkspace, but that inner page list has no visible tab
            // switcher. Migrate those local sessions once into ordinary visible
            // workspaces. Keep the active page on the original workspace ID so
            // persisted active-tab and unified-tab references stay valid.
            const migrationPlan = legacyWebAiMigrationBySourceWorkspaceId.get(tab.id)
            for (const page of nextPages) {
              const workspaceId = migrationPlan?.workspaceIdByPageId.get(page.id) ?? tab.id
              const migratedPage = { ...page, workspaceId }
              browserPagesByWorkspace[workspaceId] = [migratedPage]
              hydratedTabs.push(
                mirrorWorkspaceFromActivePage(
                  {
                    ...tab,
                    id: workspaceId,
                    activePageId: page.id,
                    pageIds: [page.id]
                  },
                  [migratedPage]
                )
              )
            }
            continue
          }

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

    for (const workspaceId of droppedWorkspaceIds) {
      const state = get()
      const unifiedTab = Object.values(state.unifiedTabsByWorktree)
        .flat()
        .find((tab) => tab.contentType === 'browser' && tab.entityId === workspaceId)
      if (unifiedTab) {
        state.closeUnifiedTab(unifiedTab.id, { recordInteraction: false })
      }
    }

    const hydratedState = get()
    for (const [worktreeId, browserTabs] of Object.entries(hydratedState.browserTabsByWorktree)) {
      for (const bt of browserTabs) {
        if (legacyWebAiSiblingSourceByWorkspaceId.has(bt.id)) {
          continue
        }
        const state = get()
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

    for (const [workspaceId, migrationSource] of legacyWebAiSiblingSourceByWorkspaceId) {
      const state = get()
      const workspace = findWorkspace(state.browserTabsByWorktree, workspaceId)
      if (!workspace) {
        continue
      }
      const tabs = state.unifiedTabsByWorktree[migrationSource.worktreeId] ?? []
      const sourceUnifiedTab = tabs.find(
        (tab) => tab.contentType === 'browser' && tab.entityId === migrationSource.sourceWorkspaceId
      )
      const existingUnifiedTab = tabs.find(
        (tab) => tab.contentType === 'browser' && tab.entityId === workspace.id
      )
      if (existingUnifiedTab) {
        continue
      }
      state.createUnifiedTab(migrationSource.worktreeId, 'browser', {
        id: legacyWebAiSiblingUnifiedTabId(workspace.id),
        entityId: workspace.id,
        label: workspace.title,
        targetGroupId: sourceUnifiedTab?.groupId,
        activate: false,
        recordInteraction: false
      })
    }

    for (const [sourceWorkspaceId, migrationPlan] of legacyWebAiMigrationBySourceWorkspaceId) {
      const state = get()
      const tabs = state.unifiedTabsByWorktree[migrationPlan.worktreeId] ?? []
      const sourceUnifiedTab = tabs.find(
        (tab) => tab.contentType === 'browser' && tab.entityId === sourceWorkspaceId
      )
      if (!sourceUnifiedTab) {
        continue
      }
      const migratedUnifiedTabIds = migrationPlan.workspaceIdsInPageOrder.flatMap((workspaceId) => {
        const tab = tabs.find(
          (entry) => entry.contentType === 'browser' && entry.entityId === workspaceId
        )
        return tab ? [tab.id] : []
      })
      const group = state.groupsByWorktree[migrationPlan.worktreeId]?.find(
        (entry) => entry.id === sourceUnifiedTab.groupId
      )
      if (!group || migratedUnifiedTabIds.length !== migrationPlan.workspaceIdsInPageOrder.length) {
        continue
      }
      const migratedTabIds = new Set(migratedUnifiedTabIds)
      const nextOrder = group.tabOrder.flatMap((tabId) => {
        if (tabId === sourceUnifiedTab.id) {
          return migratedUnifiedTabIds
        }
        return migratedTabIds.has(tabId) ? [] : [tabId]
      })
      state.reorderUnifiedTabs(group.id, nextOrder, { recordInteraction: false })
    }
  },

  switchBrowserTabProfile: (workspaceId, profileId, sessionPartition) => {
    set((s) => {
      for (const [worktreeId, tabs] of Object.entries(s.browserTabsByWorktree)) {
        const tabIndex = tabs.findIndex((t) => t.id === workspaceId)
        if (tabIndex !== -1) {
          const currentTab = tabs[tabIndex]
          const boundAccount = currentTab.webAiAccountId
            ? normalizeWebAiAccounts(s.settings?.webAiAccounts).find((account) =>
                webAiAccountMatchesBinding(account, currentTab)
              )
            : null
          if (boundAccount) {
            // Why: a saved account promises one fixed cookie partition in every
            // placement, including tabs embedded in an ordinary worktree.
            return s
          }
          const updatedTabs = [...tabs]
          updatedTabs[tabIndex] = {
            ...updatedTabs[tabIndex],
            sessionProfileId: profileId,
            sessionPartition: sessionPartition ?? null,
            // Invalid/orphan tags are sanitized when the user deliberately
            // chooses a new profile; valid account bindings returned above.
            webAiAccountId: null
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

  fetchBrowserSessionProfiles: async (owner) => {
    const runtimeTarget = getBrowserProfileOperationRuntimeTarget(get(), owner)
    const hostId = getBrowserProfileOperationHostId(get(), owner)
    if (runtimeTarget) {
      try {
        const result = await callRuntimeRpc<BrowserProfileListResult>(
          runtimeTarget,
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
    if (isRuntimeEnvironmentActive(get())) {
      try {
        const result = await callRuntimeRpc<BrowserProfileCreateResult>(
          getActiveRuntimeTarget(get().settings),
          'browser.profileCreate',
          { scope, label },
          { timeoutMs: 15_000 }
        )
        const profile = result.profile
        if (profile) {
          set((s) => ({
            ...profileListByHostUpdate(s, [...s.browserSessionProfiles, profile])
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
          ...profileListByHostUpdate(s, [...s.browserSessionProfiles, profile])
        }))
      }
      return profile
    } catch {
      return null
    }
  },

  deleteBrowserSessionProfile: async (profileId) => {
    if (isRuntimeEnvironmentActive(get())) {
      try {
        const result = await callRuntimeRpc<BrowserProfileDeleteResult>(
          getActiveRuntimeTarget(get().settings),
          'browser.profileDelete',
          { profileId },
          { timeoutMs: 15_000 }
        )
        if (result.deleted) {
          set((s) => ({
            ...profileListByHostUpdate(
              s,
              s.browserSessionProfiles.filter((p) => p.id !== profileId)
            ),
            ...(s.defaultBrowserSessionProfileId === profileId
              ? {
                  defaultBrowserSessionProfileId: null,
                  defaultBrowserSessionProfileIdByHostId: {
                    ...s.defaultBrowserSessionProfileIdByHostId,
                    [getBrowserSettingsHostId(s)]: null
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
            s.browserSessionProfiles.filter((p) => p.id !== profileId)
          ),
          ...(s.defaultBrowserSessionProfileId === profileId
            ? {
                defaultBrowserSessionProfileId: null,
                defaultBrowserSessionProfileIdByHostId: {
                  ...s.defaultBrowserSessionProfileIdByHostId,
                  [getBrowserSettingsHostId(s)]: null
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

  importCookiesToProfile: async (profileId, webAiProvider?, cookieImportScope?, owner?) => {
    if (getBrowserProfileOperationRuntimeTarget(get(), owner)) {
      const reason = 'Manual cookie file import is unavailable while a remote runtime is active.'
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
        profileId,
        webAiProvider,
        ...(cookieImportScope ? { cookieImportScope } : {})
      })) as BrowserCookieImportResult
      if (result.ok) {
        get().recordFeatureInteraction?.('cookie-import')
        set({
          browserSessionImportState: {
            profileId,
            status: 'success',
            summary: result.summary,
            error: null
          }
        })
        await get()
          .fetchBrowserSessionProfiles(owner)
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
  detectedBrowsersHostId: null,
  detectedBrowsersRequestGeneration: 0,

  fetchDetectedBrowsers: async (owner) => {
    const runtimeTarget = getBrowserProfileOperationRuntimeTarget(get(), owner)
    const hostId = getBrowserProfileOperationHostId(get(), owner)
    if (get().detectedBrowsersLoaded && get().detectedBrowsersHostId === hostId) {
      return
    }
    const requestGeneration = get().detectedBrowsersRequestGeneration + 1
    set((state) => ({
      detectedBrowsersRequestGeneration: requestGeneration,
      ...(state.detectedBrowsersHostId !== hostId
        ? {
            // Why: never show a source list discovered on one machine while an
            // import is already targeted at another owner.
            detectedBrowsers: [],
            detectedBrowsersLoaded: false,
            detectedBrowsersHostId: hostId
          }
        : {})
    }))
    const commitDetectedBrowsers = (browsers: BrowserDetectProfilesResult['browsers']): void => {
      const state = get()
      if (
        state.detectedBrowsersHostId !== hostId ||
        state.detectedBrowsersRequestGeneration !== requestGeneration
      ) {
        return
      }
      set({ detectedBrowsers: browsers, detectedBrowsersLoaded: true })
    }
    if (runtimeTarget) {
      try {
        const result = await callRuntimeRpc<BrowserDetectProfilesResult>(
          runtimeTarget,
          'browser.profileDetectBrowsers',
          undefined,
          { timeoutMs: 15_000 }
        )
        commitDetectedBrowsers(result.browsers)
      } catch {
        commitDetectedBrowsers([])
      }
      return
    }
    try {
      const browsers =
        (await window.api.browser.sessionDetectBrowsers()) as BrowserDetectProfilesResult['browsers']
      commitDetectedBrowsers(browsers)
    } catch {
      commitDetectedBrowsers([])
    }
  },

  importCookiesFromBrowser: async (
    profileId,
    browserFamily,
    browserProfile?,
    webAiProvider?,
    cookieImportScope?,
    owner?
  ) => {
    const runtimeTarget = getBrowserProfileOperationRuntimeTarget(get(), owner)
    if (runtimeTarget) {
      set({
        browserSessionImportState: {
          profileId,
          status: 'importing',
          summary: null,
          error: null
        }
      })
      try {
        const result = await callRuntimeRpc<BrowserProfileImportFromBrowserResult>(
          runtimeTarget,
          'browser.profileImportFromBrowser',
          {
            profileId,
            browserFamily,
            browserProfile,
            webAiProvider,
            ...(cookieImportScope ? { cookieImportScope } : {})
          },
          { timeoutMs: 30_000 }
        )
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
            .fetchBrowserSessionProfiles(owner)
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
    }
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
        browserProfile,
        webAiProvider,
        ...(cookieImportScope ? { cookieImportScope } : {})
      })) as BrowserCookieImportResult
      if (result.ok) {
        get().recordFeatureInteraction?.('cookie-import')
        set({
          browserSessionImportState: {
            profileId,
            status: 'success',
            summary: result.summary,
            error: null
          }
        })
        await get()
          .fetchBrowserSessionProfiles(owner)
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
    if (isRuntimeEnvironmentActive(get())) {
      try {
        const result = await callRuntimeRpc<BrowserProfileClearDefaultCookiesResult>(
          getActiveRuntimeTarget(get().settings),
          'browser.profileClearDefaultCookies',
          undefined,
          { timeoutMs: 15_000 }
        )
        if (result.cleared) {
          await get().fetchBrowserSessionProfiles()
        }
        return result.cleared
      } catch {
        return false
      }
    }
    try {
      const ok = await window.api.browser.sessionClearDefaultCookies()
      if (ok) {
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
