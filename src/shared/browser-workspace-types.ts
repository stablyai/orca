export type BrowserHistoryEntry = {
  url: string
  normalizedUrl: string
  title: string
  lastVisitedAt: number
  visitCount: number
}

export type BrowserLoadError = {
  code: number
  description: string
  validatedUrl: string
}

export type BrowserCertificateFailure = {
  challengeId: string
  browserPageId: string
  errorCode: number | null
  error: string
  origin: string
  displayHost: string
  canProceed: boolean
  observedAt: number
}

export type BrowserCertificateProceedFailureReason =
  | 'expired'
  | 'changed'
  | 'ineligible'
  | 'missing'
  | 'navigated'

export type BrowserCertificateProceedResult =
  | { ok: true }
  | { ok: false; reason: BrowserCertificateProceedFailureReason }

// Why: BrowserPage persists the active viewport preset so CDP emulation can be
// reapplied on reload/navigation without the user re-picking from the toolbar.
export type BrowserViewportPresetId =
  | 'mobile-s'
  | 'mobile-m'
  | 'mobile-l'
  | 'tablet'
  | 'laptop'
  | 'laptop-l'
  | 'desktop'

export type BrowserViewportOverride = {
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
}

/**
 * A page that shows a workspace document rather than a URL. The document is the identity: the grant
 * and the `orca-preview://` URL it is served over are minted when the page mounts and replaced on a
 * hard reload, so neither may be stored, persisted or published — this is what is, and `url` stays
 * the blank URL for the whole life of such a page.
 */
export type BrowserPageDocLocation = {
  kind: 'workspace-doc'
  worktreeId: string
  filePath: string
}

export type BrowserPage = {
  id: string
  workspaceId: string
  worktreeId: string
  /** Blank for a page whose `docLocation` is set; a live grant URL is never written here. */
  url: string
  title: string
  loading: boolean
  faviconUrl: string | null
  canGoBack: boolean
  canGoForward: boolean
  loadError: BrowserLoadError | null
  createdAt: number
  // Why: remote-owned worktrees can still host client-local fallback browser
  // pages until headless remote runtimes support real browser panes.
  browserRuntimeEnvironmentId?: string | null
  // Why: the runtime page id lives only in the in-memory handle map, so without persisting it a
  // relaunch cannot reclaim the host's page and falls through to creating a blank one.
  remoteBrowserPageId?: string | null
  /** The remote page was hosted by this desktop, not the runtime; it must not restore as streamed. */
  remoteBrowserPageClientHosted?: boolean
  /** Active CDP viewport emulation preset. null = default (fill pane, no CDP override) */
  viewportPresetId?: BrowserViewportPresetId | null
  /** Set on a page that shows a workspace document; absent on every page that shows a URL. */
  docLocation?: BrowserPageDocLocation | null
}

export type BrowserWorkspace = {
  id: string
  worktreeId: string
  /** Stable display label for the outer Orca tab ("Browser 1", "Browser 2", …).
   *  Optional so sessions persisted before this field was added fall back
   *  gracefully to the URL-derived label in getBrowserTabLabel. */
  label?: string
  // Why: each browser workspace binds to exactly one session profile at creation
  // time. The profile determines which Electron partition (and thus which
  // cookies/storage) the guest webview uses. Absent means the legacy shared
  // partition, which keeps backward compat with workspaces persisted before
  // session profiles existed.
  sessionProfileId?: string | null
  // Why: runtime-created tabs resolve profile partition in main. Persisting it
  // keeps isolated storage stable when the renderer profile mirror is stale.
  sessionPartition?: string | null
  activePageId?: string | null
  pageIds?: string[]
  // Why: the active page owns real browser chrome state now, but the top-level
  // Orca tab strip still renders one workspace entry. Mirror the active page's
  // title/url/loading metadata here so existing workspace-level UI can stay
  // stable while Phase 2 introduces nested browser pages.
  url: string
  title: string
  loading: boolean
  faviconUrl: string | null
  canGoBack: boolean
  canGoForward: boolean
  loadError: BrowserLoadError | null
  createdAt: number
  /** Mirrored from the active page, like the fields above it. */
  docLocation?: BrowserPageDocLocation | null
}

export type BrowserTab = BrowserWorkspace

export type BrowserSessionProfileScope = 'default' | 'isolated' | 'imported'

export type BrowserSessionUserAgentMode = 'clean' | 'native'

export type BrowserSessionProfileCreateOptions = {
  userAgentMode?: BrowserSessionUserAgentMode
}

export type BrowserSessionProfileSource = {
  browserFamily:
    | 'chrome'
    | 'chromium'
    | 'arc'
    | 'edge'
    | 'firefox'
    | 'safari'
    | 'comet'
    | 'helium'
    | 'manual'
  profileName?: string
  importedAt: number
}

export type BrowserSessionProfile = {
  id: string
  scope: BrowserSessionProfileScope
  partition: string
  label: string
  source: BrowserSessionProfileSource | null
  userAgentMode?: BrowserSessionUserAgentMode
}

export type BrowserCookieImportSummary = {
  totalCookies: number
  importedCookies: number
  skippedCookies: number
  googleCookiesSkipped?: number
  // Why (STA-4300): cookies whose source partition identity could not be read faithfully are
  // skipped rather than written unpartitioned, and a skip is only honest if it is reported.
  partitionSkippedCookies?: number
  domains: string[]
  warning?:
    | {
        code: 'restart-fallback-unavailable'
        loadedCookies: number
        failedCookies: number
      }
    | {
        // Why: a row that will not decrypt is indistinguishable from a corrupt one by the time
        // decrypt returns null, so the cause is captured at the point of failure and reported
        // here. Without this an undecryptable profile is reported as a successful empty import.
        code: 'cookies-undecryptable'
        failedCookies: number
        otherFailedCookies?: number
        reason: 'app-bound-encryption' | 'linux-keyring-unavailable' | 'unknown'
      }
}

export type BrowserCookieImportResult =
  | { ok: true; profileId: string; summary: BrowserCookieImportSummary }
  | { ok: false; reason: string }
