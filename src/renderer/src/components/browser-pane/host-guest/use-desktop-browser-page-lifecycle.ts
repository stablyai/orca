import { useEffect, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import {
  normalizeBrowserNavigationUrl,
  redactKagiSessionToken
} from '../../../../../shared/browser-url'
import {
  browserViewportPresetToOverride,
  getBrowserViewportPreset
} from '../../../../../shared/browser-viewport-presets'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../shared/constants'
import {
  BROWSER_GUEST_RECOVERY_ERROR_CODE,
  BROWSER_GUEST_RECOVERY_TIMEOUT_MS
} from './browser-page-guest-recovery'
import { browserPageZoomLevelToPercent } from './browser-page-zoom'
import { bindDesktopBrowserPageEvents } from './desktop-browser-page-events'
import type { DesktopBrowserPage } from './desktop-browser-page-registry'
import type { useBrowserPageWebviewLifecycle } from './use-browser-page-webview-lifecycle'
import type { BrowserPageAnnotationBridge } from '../annotate/use-browser-page-annotation-viewport'
import { isChromiumErrorPage } from '../describe-page/browser-page-url-display'

type LifecycleOptions = Parameters<typeof useBrowserPageWebviewLifecycle>[0]

export function useDesktopBrowserPageLifecycle({
  enabled,
  page,
  error,
  recover,
  options,
  annotations
}: {
  enabled: boolean
  page: DesktopBrowserPage | null
  error: unknown
  recover: () => void
  options: LifecycleOptions
  annotations: BrowserPageAnnotationBridge
}): void {
  const latest = useRef({ options, annotations })
  const faviconUrlRef = useRef(options.faviconUrl)
  const history = useAppStore((state) => state.addBrowserHistoryEntry)
  const addBrowserHistoryEntryRef = useRef(history)
  useLayoutEffect(() => {
    latest.current = { options, annotations }
    addBrowserHistoryEntryRef.current = history
  })
  useEffect(() => {
    if (!enabled) {
      return
    }
    const recoveryRef = options.retryGuestRecoveryRef
    recoveryRef.current = recover
    return () => {
      if (recoveryRef.current === recover) {
        recoveryRef.current = () => {}
      }
    }
  }, [enabled, options.retryGuestRecoveryRef, recover])
  useEffect(() => {
    if (!enabled || !error) {
      return
    }
    const current = latest.current.options
    const failure = {
      code: BROWSER_GUEST_RECOVERY_ERROR_CODE,
      description: error instanceof Error ? error.message : 'The browser page could not be opened.',
      validatedUrl: redactKagiSessionToken(current.browserTabUrlRef.current)
    }
    current.activeLoadFailureRef.current = failure
    current.onUpdatePageStateRef.current(current.browserTabId, {
      loading: false,
      loadError: failure
    })
  }, [enabled, error])
  useEffect(() => {
    if (!page) {
      return
    }
    let disposed = false
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined
    let recovering = false
    const current = latest.current.options
    const failure = (reason: string): void => {
      if (disposed) {
        return
      }
      const value = latest.current.options
      const loadError = {
        code: BROWSER_GUEST_RECOVERY_ERROR_CODE,
        description: `The browser page stopped responding (${reason}).`,
        validatedUrl: redactKagiSessionToken(value.browserTabUrlRef.current)
      }
      value.activeLoadFailureRef.current = loadError
      value.onUpdatePageStateRef.current(value.browserTabId, { loading: false, loadError })
    }
    const ready = (): void => {
      clearTimeout(recoveryTimer)
      if (
        (recovering ||
          latest.current.options.activeLoadFailureRef.current?.code ===
            BROWSER_GUEST_RECOVERY_ERROR_CODE) &&
        !page.state.loadError &&
        !isChromiumErrorPage(page.state.url)
      ) {
        recovering = false
        latest.current.options.activeLoadFailureRef.current = null
        latest.current.options.recoveryNavigationValidationRef.current = null
        latest.current.options.onUpdatePageStateRef.current(page.args.browserPageId, {
          loadError: null
        })
      }
      const value = latest.current.options
      latest.current.annotations.syncBrowserAnnotationViewportBridge()
      if (value.keepAddressBarFocusRef.current) {
        value.focusAddressBarNow()
      }
      void Promise.resolve(page.surface.setZoomLevel(value.paneZoomLevelRef.current))
        .then((level) => {
          if (!disposed && level !== null) {
            latest.current.options.setBrowserZoomPercent(browserPageZoomLevelToPercent(level))
          }
        })
        .catch((cause: unknown) => console.warn('[browser] restoring page zoom failed:', cause))
      const preset = getBrowserViewportPreset(value.viewportPresetId)
      void window.api.browser
        .setViewportOverride({
          browserPageId: page.args.browserPageId,
          override: preset ? browserViewportPresetToOverride(preset) : null
        })
        .catch((cause: unknown) => console.warn('[browser] restoring page viewport failed:', cause))
    }
    const unsubscribe = bindDesktopBrowserPageEvents(page, {
      ...current,
      ...latest.current.annotations,
      faviconUrlRef,
      addBrowserHistoryEntryRef,
      onReady: ready,
      onGone: (reason) => {
        latest.current.annotations.invalidateBrowserAnnotationDocumentRef.current()
        if (reason === 'destroyed') {
          failure(reason)
          return
        }
        if (recovering) {
          return
        }
        recovering = true
        recoveryTimer = setTimeout(() => failure(reason), BROWSER_GUEST_RECOVERY_TIMEOUT_MS)
        void Promise.resolve(page.surface.reload(false)).catch(() => failure(reason))
      },
      onFocus: () => latest.current.options.dismissAddressBarSuggestionsRef.current?.(),
      onZoom: (level) =>
        latest.current.options.setBrowserZoomPercent(browserPageZoomLevelToPercent(level)),
      onFullNavigation: () => {
        latest.current.options.setFindOpen(false)
        void Promise.resolve(page.surface.stopFind()).catch(() => {})
      }
    })
    return () => {
      disposed = true
      clearTimeout(recoveryTimer)
      unsubscribe()
    }
  }, [page])

  useEffect(() => {
    if (!page?.ready) {
      return
    }
    const preset = getBrowserViewportPreset(options.viewportPresetId)
    void window.api.browser
      .setViewportOverride({
        browserPageId: page.args.browserPageId,
        override: preset ? browserViewportPresetToOverride(preset) : null
      })
      .catch((cause: unknown) => console.warn('[browser] updating page viewport failed:', cause))
  }, [page, options.viewportPresetId])

  useEffect(() => {
    if (!page) {
      return
    }
    const value = latest.current.options
    const url = normalizeBrowserNavigationUrl(value.browserTabUrl)
    if (
      !url ||
      value.lastKnownWebviewUrlRef.current === url ||
      normalizeBrowserNavigationUrl(page.state.url) === url
    ) {
      return
    }
    if (!page.state.url && normalizeBrowserNavigationUrl(page.args.url) === url) {
      return
    }
    value.trackNextLoadingEventRef.current = url !== ORCA_BROWSER_BLANK_URL
    value.lastKnownWebviewUrlRef.current = url
    void Promise.resolve(page.surface.navigate(url)).catch((cause: unknown) => {
      console.warn('[browser] navigating desktop page failed:', cause)
      recover()
    })
    if (url !== ORCA_BROWSER_BLANK_URL) {
      value.keepAddressBarFocusRef.current = false
      if (document.activeElement === value.addressBarInputRef.current) {
        value.focusWebviewNow()
      }
    }
  }, [page, options.browserTabUrl, recover])
}
