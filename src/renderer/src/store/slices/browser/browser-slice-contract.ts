import type { StateCreator } from 'zustand'
import type { ManagedBrowserProfileOwner } from '../../../../../shared/browser-profile-scope'

/** What a new tab opens on; a partition only when it must not be derived from the profile. */
export type NewBrowserTabProfile = { sessionProfileId: string | null; sessionPartition?: string }
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
import type { TabSplitTarget } from '../tabs/tabs-slice-contract'
import type { RuntimeBrowserPlacement } from '../../../../../shared/runtime-browser-placement'

export type CreateBrowserTabOptions = {
  activate?: boolean
  browserPageId?: string
  title?: string
  sessionProfileId?: string | null
  sessionPartition?: string | null
  // Place the new tab in a specific group (e.g. "Open Preview to the Side"); defaults to the worktree's active group.
  targetGroupId?: string
  /** Creates the tab in a new split group instead of targetGroupId. */
  split?: TabSplitTarget
  /** Client-local unified tab id of the source; the new tab lands right after it when still live. */
  afterTabId?: string
  /** Verified execution host for the new wrapper; unset keeps createUnifiedTab's active-workspace fallback. */
  executionHostId?: ExecutionHostId
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
  /** Predict client hosting before live placement so staging mounts the correct component without an adoption remount. */
  stagedClientHosted?: true
  /** Restored IDs are real but host presence is unproven; exempt from omission culling until first republication clears marker. */
  restoredFromSession?: true
  /** The restored page was hosted by this desktop, so it must not restore as a streamed pane. */
  restoredClientHosted?: true
}

export type RemovedBrowserHistory = {
  browserUrlHistory: BrowserHistoryEntry[]
  workspaceDocHistory: WorkspaceDocHistoryEntry[]
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
  /** May precede the page record (client-hosted pages); main's false on guest teardown clears it. */
  browserAudiblePageIds: Record<string, true>
  /** Tab mute lives for the tab's life; each new guest of its pages is muted again. */
  browserAudioMutedTabIds: Record<string, true>
  browserAnnotationsByPageId: Record<string, BrowserPageAnnotation[]>
  browserAnnotationMarkerIdsByPageId: Record<string, string[]>
  remoteBrowserPageHandlesByPageId: Record<string, RemoteBrowserPageHandle>
  /** Persist undelivered client-page closes by environment or runtime restart restores its persisted pages. */
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
  closeBrowserTab: (
    tabId: string,
    options?: { reason?: 'cleanup'; preserveWorktreeSelection?: boolean }
  ) => void
  shutdownWorktreeBrowsers: (
    worktreeId: string,
    options?: { preserveWorktreeSelection?: boolean }
  ) => void
  reopenClosedBrowserTab: (worktreeId: string) => BrowserWorkspace | null
  /** Activation uses the tab's workspace unless a target is supplied; global selection
   *  moves only when that workspace is active. */
  setActiveBrowserTab: (tabId: string, targetWorktreeId?: string) => void
  createBrowserPage: (
    workspaceId: string,
    url: string,
    options?: CreateBrowserPageOptions
  ) => BrowserPage | null
  closeBrowserPage: (pageId: string) => void
  // Doc/web kinds are immutable; conversion replaces page with fresh ID in surviving workspace to keep main registries disjoint.
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
  setBrowserPageAudible: (pageId: string, audible: boolean) => void
  setBrowserTabAudioMuted: (tabId: string, muted: boolean) => void
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
  invalidateBrowserPageAnnotationGeometry: (pageId: string) => void
  removeDeliveredBrowserPageAnnotations: (
    pageId: string,
    deliveredAnnotations: readonly BrowserPageAnnotation[]
  ) => void
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
  /** Loads one host's profiles; defaults to the host Browser settings is showing. */
  fetchBrowserSessionProfiles: (hostId?: ExecutionHostId) => Promise<void>
  createBrowserSessionProfile: (
    scope: 'isolated' | 'imported',
    label: string
  ) => Promise<BrowserSessionProfile | null>
  deleteBrowserSessionProfile: (profileId: string) => Promise<boolean>
  /** A repo's or workspace's own local profile, at once; a placeholder until main first creates it. */
  ensureManagedBrowserSessionProfile: (
    owner: ManagedBrowserProfileOwner,
    label: string
  ) => NewBrowserTabProfile
  /** A removed repo's or workspace's own profile goes with it, whichever host ran the removal. */
  deleteManagedBrowserSessionProfile: (owner: ManagedBrowserProfileOwner) => Promise<void>
  /** Managed profiles main has not finished creating; their pages must not mount on any other partition. */
  managedBrowserProfileStatusById: Record<string, 'pending' | 'failed'>
  importCookiesToProfile: (profileId: string) => Promise<BrowserCookieImportExecutionResult>
  clearBrowserSessionImportState: () => void
  detectedBrowsers: {
    family: string
    label: string
    profiles: { name: string; directory: string }[]
    selectedProfile: string
  }[]
  detectedBrowsersLoaded: boolean
  // Record detector machine for import menus; null while settings target local host.
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
  /** Returns the removed entry so an Undo can put it back with its visit count. */
  removeBrowserHistoryEntry: (normalizedUrl: string) => BrowserHistoryEntry | null
  /** Puts removed or cleared entries back, except ones a revisit has already re-created. */
  restoreBrowserHistory: (removed: RemovedBrowserHistory) => void
  workspaceDocHistory: WorkspaceDocHistoryEntry[]
  removeWorkspaceDocHistoryEntry: (docLocation: BrowserPageDocLocation) => void
  /** A visit bumps recency and count; a title-only refresh (bump: false) renames the row. */
  recordWorkspaceDocVisit: (
    docLocation: BrowserPageDocLocation,
    title: string | null,
    options?: { bump?: boolean }
  ) => void
  /** Clears pages and documents last visited at or after `since` (everything when omitted). */
  clearBrowserHistory: (since?: number) => RemovedBrowserHistory
  /** The page whose history view is open; it opens what you pick in that page. */
  browserHistoryPageId: string | null
  setBrowserHistoryPageId: (pageId: string | null) => void
  defaultBrowserSessionProfileId: string | null
  defaultBrowserSessionProfileIdByHostId: Partial<Record<ExecutionHostId, string | null>>
  setDefaultBrowserSessionProfileId: (profileId: string | null) => void
}

type BrowserStateCreator = StateCreator<AppState, [], [], BrowserSlice>
export type BrowserSliceSet = Parameters<BrowserStateCreator>[0]
export type BrowserSliceGet = Parameters<BrowserStateCreator>[1]

export type { BrowserPageConversionLeg, BrowserPageConversionTarget, BrowserSessionProfile }
