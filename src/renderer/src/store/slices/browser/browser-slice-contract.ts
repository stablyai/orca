import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type {
  BrowserCertificateFailure,
  BrowserCookieImportResult,
  BrowserCookieImportSummary,
  BrowserHistoryEntry,
  BrowserLoadError,
  BrowserPage,
  BrowserPageDocLocation,
  BrowserSessionProfile,
  BrowserSessionProfileCreateOptions,
  BrowserViewportPresetId,
  BrowserWorkspace
} from '../../../../../shared/browser-workspace-types'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session-state-types'
import type { WorkspaceDocHistoryEntry } from '../../../../../shared/workspace-doc-history'
import type {
  BrowserAnnotationIntent,
  BrowserPageAnnotation
} from '../../../../../shared/browser-grab-types'
import type {
  BrowserPageConversionLeg,
  BrowserPageConversionTarget
} from '../browser-page-conversion'
import type { RecentlyClosedTabPosition } from '../recently-closed-tabs'
import type {
  ClientHostedBrowserCloseIntentsByEnvironment,
  PendingClientHostedBrowserClose
} from '@/runtime/client-hosted-browser-close-intents'
import type { WorkspaceSessionHydrationOptions } from '@/lib/workspace-session-hydration-keys'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { RuntimeBrowserPlacement } from '../../../../../shared/runtime-browser-placement'

export type CreateBrowserTabOptions = {
  activate?: boolean
  browserPageId?: string
  title?: string
  sessionProfileId?: string | null
  sessionPartition?: string | null
  // Place the new tab in a specific group (e.g. "Open Preview to the Side"); defaults to the worktree's active group.
  targetGroupId?: string
  // Explicit "New Tab" focuses the address bar even with a real home URL; link-opened tabs leave it unset.
  focusAddressBar?: boolean
  browserRuntimeEnvironmentId?: string | null
  /** Creates a page that shows a workspace document instead of a URL. */
  docLocation?: BrowserPageDocLocation
}

export type CreateBrowserPageOptions = {
  activate?: boolean
  title?: string
  browserRuntimeEnvironmentId?: string | null
  /** Creates a page that shows a workspace document instead of a URL. */
  docLocation?: BrowserPageDocLocation
}

export type BrowserTabPageState = {
  title?: string
  loading?: boolean
  faviconUrl?: string | null
  canGoBack?: boolean
  canGoForward?: boolean
  loadError?: BrowserLoadError | null
}

export type SetBrowserPageUrlOptions = {
  preserveLoadError?: boolean
}

export type ClosedBrowserWorkspaceSnapshot = {
  workspace: BrowserWorkspace
  pages: BrowserPage[]
  position?: RecentlyClosedTabPosition
}

export type RemoteBrowserPageHandle = {
  environmentId: string
  remotePageId: string
  placement?: RuntimeBrowserPlacement
  /** Optimistically staged by this client; the host has not published the page yet. */
  staged?: true
  /**
   * This client expects to host the staged page itself. The real placement is minted host-side and
   * only arrives with the snapshot, so the pane needs this to mount as the right kind of pane from
   * the first frame instead of swapping components at adoption.
   */
  stagedClientHosted?: true
  /**
   * Rebuilt at hydration from the persisted page row rather than observed from a host snapshot. The
   * page id is real, but nothing has confirmed the host still has it, so the row is exempt from the
   * absent-from-snapshot cull until the first snapshot that publishes it clears this.
   */
  restoredFromSession?: true
  /** The restored page was hosted by this desktop, so it must not restore as a streamed pane. */
  restoredClientHosted?: true
}

export type BrowserCookieImportExecutionResult = BrowserCookieImportResult & {
  executionHostId: ExecutionHostId
  executionHostLabel: string
  // Why: for a remote environment the import silently runs on either machine; toasts must say which.
  executionMachine: 'client' | 'remote'
  executionRemoteEnvironment: boolean
}

export type BrowserSlice = {
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>
  browserPagesByWorkspace: Record<string, BrowserPage[]>
  browserCertificateFailuresByPageId: Record<string, BrowserCertificateFailure>
  browserAnnotationsByPageId: Record<string, BrowserPageAnnotation[]>
  remoteBrowserPageHandlesByPageId: Record<string, RemoteBrowserPageHandle>
  /**
   * Closes of client-hosted pages their owning runtime never heard, keyed by environment.
   *
   * Durable because the runtime persists the pages themselves: a close swallowed while the host
   * was down would otherwise be undone by that host's next start.
   */
  clientHostedBrowserCloseIntentsByEnvironment: ClientHostedBrowserCloseIntentsByEnvironment
  recordClientHostedBrowserCloseIntents: (
    closes: readonly PendingClientHostedBrowserClose[]
  ) => void
  clearClientHostedBrowserCloseIntents: (
    environmentId: string,
    browserPageIds: readonly string[]
  ) => void
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
  /** `profileId: null` uses the workspace default profile. */
  openBrowserProfileTabInActiveWorkspace: (
    url: string,
    profileId: string | null
  ) => Promise<boolean>
  closeBrowserTab: (tabId: string, options?: { reason?: 'cleanup' }) => void
  shutdownWorktreeBrowsers: (worktreeId: string) => Promise<void>
  reopenClosedBrowserTab: (worktreeId: string) => BrowserWorkspace | null
  setActiveBrowserTab: (tabId: string) => void
  createBrowserPage: (
    workspaceId: string,
    url: string,
    options?: CreateBrowserPageOptions
  ) => BrowserPage | null
  closeBrowserPage: (pageId: string) => void
  // Why replacement and not mutation: a page's kind (doc vs web) is immutable for its life, so the
  // address bar converts by replacing the page — fresh id, same workspace row — keeping the two
  // main-process registry halves disjoint by construction.
  convertBrowserPage: (
    pageId: string,
    target: BrowserPageConversionTarget,
    options?: { leg?: BrowserPageConversionLeg }
  ) => BrowserPage | null
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
  setBrowserPageUrl: (pageId: string, url: string, options?: SetBrowserPageUrlOptions) => void
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
  updateBrowserPageAnnotation: (
    pageId: string,
    annotationId: string,
    patch: { comment: string; intent: BrowserAnnotationIntent }
  ) => void
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
    label: string,
    options?: BrowserSessionProfileCreateOptions
  ) => Promise<BrowserSessionProfile | null>
  deleteBrowserSessionProfile: (profileId: string) => Promise<boolean>
  importCookiesToProfile: (profileId: string) => Promise<BrowserCookieImportExecutionResult>
  clearBrowserSessionImportState: () => void
  detectedBrowsers: {
    family: string
    label: string
    profiles: { name: string; directory: string }[]
    selectedProfile: string
  }[]
  detectedBrowsersLoaded: boolean
  // Why: which machine answered detection for a remote environment, so import menus can say where
  // the import will read and store; null while browser settings target the local host.
  detectedBrowsersHost: { machine: 'client' | 'remote'; hostLabel: string } | null
  fetchDetectedBrowsers: () => Promise<void>
  importCookiesFromBrowser: (
    profileId: string,
    browserFamily: string,
    browserProfile?: string
  ) => Promise<BrowserCookieImportExecutionResult>
  clearDefaultSessionCookies: () => Promise<boolean>
  browserUrlHistory: BrowserHistoryEntry[]
  addBrowserHistoryEntry: (url: string, title: string, faviconUrl?: string | null) => void
  workspaceDocHistory: WorkspaceDocHistoryEntry[]
  /** A visit bumps recency and count; a title-only refresh (bump: false) renames the row. */
  recordWorkspaceDocVisit: (
    docLocation: BrowserPageDocLocation,
    title: string | null,
    options?: { bump?: boolean }
  ) => void
  clearBrowserHistory: () => void
  defaultBrowserSessionProfileId: string | null
  defaultBrowserSessionProfileIdByHostId: Partial<Record<ExecutionHostId, string | null>>
  setDefaultBrowserSessionProfileId: (profileId: string | null) => void
}

type BrowserStateCreator = StateCreator<AppState, [], [], BrowserSlice>
export type BrowserSliceSet = Parameters<BrowserStateCreator>[0]
export type BrowserSliceGet = Parameters<BrowserStateCreator>[1]

// Keep the public slice surface's domain types available to existing consumers while the
// implementation is split across focused modules.
export type { BrowserPageConversionLeg, BrowserPageConversionTarget, BrowserSessionProfile }
