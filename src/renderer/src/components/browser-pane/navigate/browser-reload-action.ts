import { BROWSER_GUEST_RECOVERY_ERROR_CODE } from '../host-guest/browser-page-guest-recovery'

/** Where the reload request came from: the toolbar button, or an explicit menu entry. */
export type BrowserReloadTrigger = 'button' | 'reload' | 'hard-reload'

export type BrowserReloadIntent =
  | 'stop'
  | 'retry-guest-recovery'
  | 'retry-load'
  | 'reload'
  | 'hard-reload'

export type BrowserReloadState = {
  loading: boolean
  loadErrorCode: number | null
}

/**
 * Why: webview.reload() only refreshes a chrome-error:// page, so a failed load has to go through the
 * recovery paths no matter which entry point asked for it. Only the toolbar button doubles as Stop.
 */
export function resolveBrowserReloadIntent(
  trigger: BrowserReloadTrigger,
  state: BrowserReloadState
): BrowserReloadIntent {
  if (trigger === 'button' && state.loading) {
    return 'stop'
  }
  if (state.loadErrorCode !== null) {
    return state.loadErrorCode === BROWSER_GUEST_RECOVERY_ERROR_CODE
      ? 'retry-guest-recovery'
      : 'retry-load'
  }
  return trigger === 'hard-reload' ? 'hard-reload' : 'reload'
}

export type BrowserPageWebviewReloadResult = 'reloaded' | 'guest-missing' | 'not-ready'

/**
 * Why: reload on a guestless webview throws uncaught ("The WebView must be attached to the
 * DOM…", STA-3448). getWebContentsId() only needs an attached guest, so it separates a dead
 * guest (route to guest recovery) from a live pre-dom-ready one (a load is already in flight).
 */
export function reloadBrowserPageWebview(
  webview: Electron.WebviewTag,
  { ignoreCache }: { ignoreCache: boolean }
): BrowserPageWebviewReloadResult {
  try {
    webview.getWebContentsId()
  } catch {
    return 'guest-missing'
  }
  try {
    if (ignoreCache) {
      webview.reloadIgnoringCache()
    } else {
      webview.reload()
    }
  } catch {
    try {
      webview.getWebContentsId()
    } catch {
      // Why: the guest can be destroyed between the liveness probe and reload.
      return 'guest-missing'
    }
    return 'not-ready'
  }
  return 'reloaded'
}

/** Accessible name for the toolbar button, which is Stop mid-load and Retry after a failure. */
export type BrowserReloadButtonLabelKind = 'stop' | 'retry' | 'reload'

export function resolveBrowserReloadButtonLabelKind(
  state: BrowserReloadState
): BrowserReloadButtonLabelKind {
  if (state.loading) {
    return 'stop'
  }
  return state.loadErrorCode !== null ? 'retry' : 'reload'
}
