import { BROWSER_GUEST_RECOVERY_ERROR_CODE } from '../host-guest/browser-page-guest-recovery'

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

/** reload() only refreshes chrome-error://; retry failed loads through recovery. Only the toolbar button doubles as Stop. */
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

/** getWebContentsId separates destroyed guests needing recovery from live pre-dom-ready guests already loading; reload throws for both. */
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

export type BrowserReloadButtonLabelKind = 'stop' | 'retry' | 'reload'

export function resolveBrowserReloadButtonLabelKind(
  state: BrowserReloadState
): BrowserReloadButtonLabelKind {
  if (state.loading) {
    return 'stop'
  }
  return state.loadErrorCode !== null ? 'retry' : 'reload'
}
