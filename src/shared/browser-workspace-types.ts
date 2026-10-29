import type { GoogleCookieClearLocalReceipt } from './browser-google-cookie-clear'
import type { ManagedBrowserProfileOwner } from './browser-profile-scope'
export type BrowserHistoryEntry = {
  url: string
  normalizedUrl: string
  title: string
  faviconUrl?: string | null
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

// Persist viewport presets to reapply CDP emulation after navigation/reload.
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

export type BrowserViewportScrollState = {
  scrollLeft: number
  scrollTop: number
  maxScrollLeft: number
  maxScrollTop: number
}

/** Persist workspace document identity only; mount/reload mints fresh grants/orca-preview URLs, which must never be stored or published. url stays blank for the document page. */
export type BrowserPageDocLocation = {
  kind: 'workspace-doc'
  worktreeId: string
  filePath: string
}

/** Keep one-level Back provenance: document identity or an already-fenced stored URL, never grant URLs. */
export type BrowserPageConversionOrigin =
  | { kind: 'workspace-doc'; docLocation: BrowserPageDocLocation }
  | {
      kind: 'url'
      url: string
      /** The origin page's runtime ownership, so Back cannot silently move browsing onto this
       *  desktop: absent = worktree-inferred, null = client-local, string = that runtime. */
      browserRuntimeEnvironmentId?: string | null
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
  // Remote worktrees may still use client-local fallback pages until headless runtimes support browser panes.
  browserRuntimeEnvironmentId?: string | null
  // Persist runtime page identity so relaunch reclaims its page instead of creating a blank one.
  remoteBrowserPageId?: string | null
  /** The remote page was hosted by this desktop, not the runtime; it must not restore as streamed. */
  remoteBrowserPageClientHosted?: boolean
  /** Active CDP viewport emulation preset. null = default (fill pane, no CDP override) */
  viewportPresetId?: BrowserViewportPresetId | null
  /** Set on a page that shows a workspace document; absent on every page that shows a URL. */
  docLocation?: BrowserPageDocLocation | null
  /** Set on a page the address bar converted from the other kind; absent everywhere else. */
  convertedFrom?: BrowserPageConversionOrigin | null
  /** Set on a page Back returned across a conversion to; Forward re-crosses it. */
  convertedTo?: BrowserPageConversionOrigin | null
}

export type BrowserWorkspace = {
  id: string
  worktreeId: string
  /** Stable outer tab label; older saved sessions fall back to getBrowserTabLabel URL naming. */
  label?: string
  // Bind each workspace to its creation profile/partition for cookies/storage; absence retains the legacy shared partition.
  sessionProfileId?: string | null
  // Persist main-resolved runtime profile partitions to retain isolated storage when renderer mirrors are stale.
  sessionPartition?: string | null
  activePageId?: string | null
  pageIds?: string[]
  // Mirror active-page title/URL/loading into the outer workspace entry for existing tab-strip consumers.
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
    | 'vivaldi'
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
  /** Set when Orca manages this profile for one repo or workspace; it goes when its owner is removed. */
  owner?: ManagedBrowserProfileOwner
}

export type LinuxCookieKeyFailure = 'secret-tool-missing' | 'keyring-locked' | 'key-unavailable'

export type BrowserCookieImportSummary = {
  totalCookies: number
  importedCookies: number
  skippedCookies: number
  googleCookiesSkipped?: number
  // Includes readable cookies withheld to preserve a site with an unreadable partition.
  partitionSkippedCookies?: number
  // Older peers retain the combined count; no cookie details cross this boundary.
  partitionSkipBreakdown?: {
    unreadableCookies: number
    preservedRelatedCookies: number
  }
  domains: string[]
  warning?: {
    // Capture decrypt failure cause before null merges unreadable and corrupt rows, preventing false successful-empty imports.
    code: 'cookies-undecryptable'
    failedCookies: number
    otherFailedCookies?: number
    reason: 'app-bound-encryption' | 'linux-keyring-unavailable' | 'unknown'
    keyringFailure?: { cause: LinuxCookieKeyFailure; browser: string }
  }
}

export type BrowserCookieImportResult =
  | {
      ok: true
      profileId: string
      summary: BrowserCookieImportSummary
      googleCookieClearTarget?: GoogleCookieClearLocalReceipt
    }
  | { ok: false; reason: string }
