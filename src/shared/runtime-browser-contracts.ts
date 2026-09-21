import type {
  BrowserCertificateFailure,
  BrowserCookieImportResult,
  BrowserLoadError,
  BrowserSessionProfile,
  BrowserSessionProfileSource
} from './browser-workspace-types'
import type { BROWSER_UNAVAILABLE_ERROR_CODE } from './runtime-session-contracts'

export type BrowserSnapshotRef = { ref: string; role: string; name: string }

export type BrowserSnapshotResult = {
  browserPageId: string
  snapshot: string
  refs: BrowserSnapshotRef[]
  url: string
  title: string
}

export type BrowserClickResult = { clicked: string }
export type BrowserGotoResult = { url: string; title: string }
export type BrowserFillResult = { filled: string }
export type BrowserTypeResult = { typed: boolean }
export type BrowserSelectResult = { selected: string }
export type BrowserScrollResult = { scrolled: 'up' | 'down' }
export type BrowserBackResult = { url: string; title: string }
export type BrowserReloadResult = { url: string; title: string }
export type BrowserScreenshotResult = { data: string; format: 'png' | 'jpeg' }

export type BrowserScreencastReadyResult = {
  type: 'ready'
  subscriptionId: string
  browserPageId: string
  format: 'jpeg' | 'png'
  tab: BrowserTabInfo
}

export type BrowserScreencastEndResult = { type: 'end'; subscriptionId: string }
export type BrowserScreencastDialogResult = { type: 'dialog'; dialogType: string; message: string }
export type BrowserScreencastDialogClosedResult = { type: 'dialogClosed' }
export type BrowserScreencastErrorResult = { type: 'error'; message: string }

export type BrowserScreencastResult =
  | BrowserScreencastReadyResult
  | BrowserScreencastEndResult
  | BrowserScreencastDialogResult
  | BrowserScreencastDialogClosedResult
  | BrowserScreencastErrorResult

export type BrowserEvalResult = { result: string; origin: string }

export type BrowserTabInfo = {
  browserPageId: string
  index: number
  url: string
  title: string
  active: boolean
  loadError?: BrowserLoadError | null
  certificateFailure?: BrowserCertificateFailure | null
  worktreeId?: string | null
  profileId?: string | null
  profileLabel?: string | null
}

export type BrowserTabListResult = { tabs: BrowserTabInfo[] }
export type BrowserTabSwitchResult = { switched: number; browserPageId: string }

export type BrowserTabSetProfileResult = {
  browserPageId: string
  profileId: string | null
  profileLabel: string | null
}

export type BrowserTabShowResult = { tab: BrowserTabInfo }
export type BrowserTabCurrentResult = { tab: BrowserTabInfo }

export type BrowserTabProfileShowResult = {
  browserPageId: string
  worktreeId: string | null
  profileId: string | null
  profileLabel: string | null
}

export type BrowserTabProfileCloneResult = {
  browserPageId: string
  sourceBrowserPageId: string
  profileId: string | null
  profileLabel: string | null
}

export type BrowserProfileListResult = { profiles: BrowserSessionProfile[] }
export type BrowserProfileCreateResult = { profile: BrowserSessionProfile | null }
export type BrowserProfileDeleteResult = { deleted: boolean; profileId: string }
export type BrowserDetectedProfileInfo = { name: string; directory: string }

export type BrowserDetectedInfo = {
  family: BrowserSessionProfileSource['browserFamily']
  label: string
  profiles: BrowserDetectedProfileInfo[]
  selectedProfile: string
}

export type BrowserDetectProfilesResult = { browsers: BrowserDetectedInfo[] }
export type BrowserProfileImportFromBrowserResult = BrowserCookieImportResult
export type BrowserProfileClearDefaultCookiesResult = { cleared: boolean }
export type BrowserHoverResult = { hovered: string }
export type BrowserDragResult = { dragged: { from: string; to: string } }
export type BrowserUploadResult = { uploaded: number }
export type BrowserWaitResult = { waited: boolean }
export type BrowserCheckResult = { checked: boolean }
export type BrowserFocusResult = { focused: string }
export type BrowserClearResult = { cleared: string }
export type BrowserSelectAllResult = { selected: string }
export type BrowserKeypressResult = { pressed: string }
export type BrowserPdfResult = { data: string }

export type BrowserCookie = {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: string
}

export type BrowserCookieGetResult = { cookies: BrowserCookie[] }
export type BrowserCookieSetResult = { success: boolean }
export type BrowserCookieDeleteResult = { deleted: boolean }

export type BrowserViewportResult = {
  width: number
  height: number
  deviceScaleFactor: number
  mobile: boolean
}

export type BrowserGeolocationResult = {
  latitude: number
  longitude: number
  accuracy: number
}

export type BrowserInterceptedRequest = {
  id: string
  url: string
  method: string
  headers: Record<string, string>
  resourceType: string
}

export type BrowserInterceptEnableResult = { enabled: boolean; patterns: string[] }
export type BrowserInterceptDisableResult = { disabled: boolean }

export type BrowserConsoleEntry = {
  level: string
  text: string
  timestamp: number
  url?: string
  line?: number
}

export type BrowserConsoleResult = { entries: BrowserConsoleEntry[]; truncated: boolean }

export type BrowserNetworkEntry = {
  url: string
  method: string
  status: number
  mimeType: string
  size: number
  timestamp: number
}

export type BrowserNetworkLogResult = { entries: BrowserNetworkEntry[]; truncated: boolean }
export type BrowserCaptureStartResult = { capturing: boolean }
export type BrowserCaptureStopResult = { stopped: boolean }
export type BrowserTabCreateResult = { browserPageId: string }

export type BrowserErrorCode =
  | typeof BROWSER_UNAVAILABLE_ERROR_CODE
  | 'browser_command_unavailable'
  | 'browser_profile_unavailable'
  | 'browser_screencast_unavailable'
  | 'browser_certificate_trust_unavailable'
  | 'browser_no_tab'
  | 'browser_tab_not_found'
  | 'browser_tab_closed'
  | 'browser_tab_changed'
  | 'browser_owner_unavailable'
  | 'browser_stale_ref'
  | 'browser_ref_not_found'
  | 'browser_navigation_failed'
  | 'browser_element_not_interactable'
  | 'browser_eval_error'
  | 'browser_cdp_error'
  | 'browser_debugger_detached'
  | 'browser_timeout'
  | 'browser_error'
