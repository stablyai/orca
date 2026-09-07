import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { redactKagiSessionToken } from '../../../../../shared/browser-url'
import {
  browserViewportPresetToOverride,
  getBrowserViewportPreset
} from '../../../../../shared/browser-viewport-presets'
import type {
  BrowserLoadError,
  BrowserViewportPresetId
} from '../../../../../shared/browser-workspace-types'
import { translate } from '@/i18n/i18n'
import {
  BROWSER_GUEST_RECOVERY_ERROR_CODE,
  createBrowserPageGuestRecovery,
  type BrowserPageGuestRecovery
} from './browser-page-guest-recovery'
import { browserPageZoomLevelToPercent, setBrowserPageZoomLevel } from './browser-page-zoom'
import { registeredWebContentsIds, replacePersistentWebview } from './webview-registry'
import { browserPageExists } from '../describe-page/browser-page-load-error'
import type {
  BrowserPageRecoveryNavigationValidation,
  BrowserTabPageState
} from '../describe-page/browser-page-types'

export type BrowserPageWebviewGuestSessionArgs = {
  webview: Electron.WebviewTag
  browserTabId: string
  workspaceId: string
  worktreeId: string
  sessionProfileId: string | null
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  isPaintableRef: MutableRefObject<boolean>
  guestRecoveryPendingRef: MutableRefObject<boolean>
  browserTabUrlRef: MutableRefObject<string>
  addressBarValueRef: MutableRefObject<string>
  activeLoadFailureRef: MutableRefObject<BrowserLoadError | null>
  recoveryNavigationValidationRef: MutableRefObject<BrowserPageRecoveryNavigationValidation | null>
  keepAddressBarFocusRef: MutableRefObject<boolean>
  paneZoomLevelRef: MutableRefObject<number>
  viewportPresetIdRef: MutableRefObject<BrowserViewportPresetId | null>
  onUpdatePageStateRef: MutableRefObject<(tabId: string, updates: BrowserTabPageState) => void>
  setGuestRecoveryGeneration: Dispatch<SetStateAction<number>>
  setBrowserZoomPercent: Dispatch<SetStateAction<number>>
  focusAddressBarNow: () => boolean
  syncNavigationState: (webview: Electron.WebviewTag) => void
  syncBrowserAnnotationViewportBridge: () => void
}

export type BrowserPageWebviewGuestSession = {
  guestRecovery: BrowserPageGuestRecovery
  handleDidAttach: () => void
  handleDomReady: () => void
  handleGuestDestroyed: () => void
}

export function createBrowserPageWebviewGuestSession({
  webview,
  browserTabId,
  workspaceId,
  worktreeId,
  sessionProfileId,
  webviewRef,
  isPaintableRef,
  guestRecoveryPendingRef,
  browserTabUrlRef,
  addressBarValueRef,
  activeLoadFailureRef,
  recoveryNavigationValidationRef,
  keepAddressBarFocusRef,
  paneZoomLevelRef,
  viewportPresetIdRef,
  onUpdatePageStateRef,
  setGuestRecoveryGeneration,
  setBrowserZoomPercent,
  focusAddressBarNow,
  syncNavigationState,
  syncBrowserAnnotationViewportBridge
}: BrowserPageWebviewGuestSessionArgs): BrowserPageWebviewGuestSession {
  let registrationInFlight: {
    webContentsId: number
    promise: Promise<boolean | null>
  } | null = null
  const registerGuest = (): Promise<boolean | null> => {
    let webContentsId: number
    try {
      webContentsId = webview.getWebContentsId()
    } catch {
      return Promise.resolve(null)
    }
    if (registrationInFlight?.webContentsId === webContentsId) {
      return registrationInFlight.promise
    }
    const promise = window.api.browser
      .registerGuest({
        browserPageId: browserTabId,
        workspaceId,
        worktreeId,
        sessionProfileId,
        webContentsId
      })
      .then((registered) => {
        if (registered) {
          registeredWebContentsIds.set(browserTabId, webContentsId)
          return true
        }
        return null
      })
      // Why: registration rejection can be an attach-policy race; only validation of an identified guest proves loss.
      .catch(() => null)
      .finally(() => {
        if (registrationInFlight?.promise === promise) {
          registrationInFlight = null
        }
      })
    registrationInFlight = { webContentsId, promise }
    return promise
  }

  const clearGuestRecoveryError = (): void => {
    if (activeLoadFailureRef.current?.code !== BROWSER_GUEST_RECOVERY_ERROR_CODE) {
      return
    }
    activeLoadFailureRef.current = null
    onUpdatePageStateRef.current(browserTabId, { loading: false, loadError: null })
  }

  const guestRecovery = createBrowserPageGuestRecovery({
    webview,
    browserPageExists: () => browserPageExists(browserTabId),
    shouldValidate: () => isPaintableRef.current,
    isCurrentWebview: () => webviewRef.current === webview,
    isPending: () => guestRecoveryPendingRef.current,
    setPending: (pending) => {
      guestRecoveryPendingRef.current = pending
    },
    validateRegistration: async () => {
      let webContentsId: number
      try {
        webContentsId = webview.getWebContentsId()
      } catch {
        // Why: a reused webview can remount before dom-ready; only an identified guest can be declared missing.
        return null
      }
      if (registeredWebContentsIds.get(browserTabId) !== webContentsId) {
        return registerGuest()
      }
      const registered = await window.api.browser.isGuestRegistered({
        browserPageId: browserTabId,
        webContentsId
      })
      if (registered) {
        return true
      }
      return window.api.browser.repairGuestRegistration({
        browserPageId: browserTabId,
        workspaceId,
        worktreeId,
        sessionProfileId,
        webContentsId
      })
    },
    replaceGuest: () => replacePersistentWebview(browserTabId),
    onReplacementReady: () => setGuestRecoveryGeneration((generation) => generation + 1),
    onRecoveryFailed: () => {
      const loadError = {
        code: BROWSER_GUEST_RECOVERY_ERROR_CODE,
        description: translate(
          'browser.guestRecovery.failed',
          'The browser page stopped unexpectedly. Retry to restore it.'
        ),
        validatedUrl: redactKagiSessionToken(
          browserTabUrlRef.current || addressBarValueRef.current || 'about:blank'
        )
      }
      activeLoadFailureRef.current = loadError
      onUpdatePageStateRef.current(browserTabId, { loading: false, loadError })
    },
    onRecoverySucceeded: clearGuestRecoveryError
  })

  const handleDidAttach = (): void => {
    // Why: register at attach since cert failures can precede dom-ready; the dom-ready path stays an idempotent fallback.
    void registerGuest().then((registered) => {
      if (registered === true) {
        guestRecovery.confirmRegistration()
      }
      syncBrowserAnnotationViewportBridge()
    })
  }

  const handleDomReady = (): void => {
    const validateRecoveryAfterNavigation =
      recoveryNavigationValidationRef.current?.committed === true
    if (validateRecoveryAfterNavigation) {
      recoveryNavigationValidationRef.current = null
    }
    let liveWebContentsId: number | null = null
    try {
      liveWebContentsId = webview.getWebContentsId()
    } catch {
      // Why: the guest can detach between dom-ready and registration.
    }
    const queuedAnnotationViewportBridgeSync =
      liveWebContentsId === null || registeredWebContentsIds.get(browserTabId) !== liveWebContentsId
    if (queuedAnnotationViewportBridgeSync) {
      void registerGuest().then((registered) => {
        const completedRecovery = guestRecovery.finish()
        if (registered === true) {
          guestRecovery.confirmRegistration()
          clearGuestRecoveryError()
        }
        if (registered === null || completedRecovery || validateRecoveryAfterNavigation) {
          guestRecovery.validateAfterResume()
        }
        syncBrowserAnnotationViewportBridge()
      })
    } else {
      const completedRecovery = guestRecovery.finish()
      if (completedRecovery || validateRecoveryAfterNavigation) {
        guestRecovery.validateAfterResume()
      }
    }
    syncNavigationState(webview)
    if (keepAddressBarFocusRef.current) {
      focusAddressBarNow()
    }
    if (!queuedAnnotationViewportBridgeSync) {
      syncBrowserAnnotationViewportBridge()
    }
    // Why: Chromium restores per-origin zoom on reload/navigation, so reassert THIS pane's level after
    // every guest load. Uses the pane-local level, not the shared setting, so reloading one tab never
    // adopts a zoom the user applied to a different tab.
    const appliedLevel = setBrowserPageZoomLevel(webview, paneZoomLevelRef.current)
    if (appliedLevel !== null) {
      setBrowserZoomPercent(browserPageZoomLevelToPercent(appliedLevel))
    }
    // Why: CDP viewport overrides are scoped to the debugger session and don't survive cross-origin nav, so reapply (idempotently) on dom-ready.
    const presetId = viewportPresetIdRef.current
    const preset = getBrowserViewportPreset(presetId)
    // Why: reapply even null so CDP matches store state; setDeviceMetricsOverride persists across same-origin nav and would leave a stale viewport.
    void window.api.browser.setViewportOverride({
      browserPageId: browserTabId,
      override: preset ? browserViewportPresetToOverride(preset) : null
    })
  }

  const handleGuestDestroyed = (): void => {
    // Why: a guest can be destroyed without render-process-gone (detach/reattach race,
    // guest-side close). Skip intentional teardown, where the element already left the DOM.
    if (webview.isConnected) {
      guestRecovery.recoverRenderer()
    }
  }

  return {
    guestRecovery,
    handleDidAttach,
    handleDomReady,
    handleGuestDestroyed
  }
}
