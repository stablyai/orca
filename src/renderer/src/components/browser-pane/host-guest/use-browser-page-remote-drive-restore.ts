import { useEffect, useLayoutEffect, useRef } from 'react'
import {
  browserViewportPresetToOverride,
  getBrowserViewportPreset
} from '../../../../../shared/browser-viewport-presets'
import type { BrowserViewportPresetId } from '../../../../../shared/browser-workspace-types'
import { setBrowserPageViewportPresetSize } from './browser-page-viewport'

export function resyncWebviewEmbedderBounds(webview: HTMLElement | null): (() => void) | undefined {
  if (!webview) {
    return undefined
  }
  const width = Math.floor(webview.getBoundingClientRect().width)
  if (!Number.isFinite(width) || width <= 1) {
    return undefined
  }
  const previousInlineWidth = webview.style.width
  webview.style.width = `${width - 1}px`
  void webview.offsetWidth
  if (typeof requestAnimationFrame !== 'function') {
    webview.style.width = previousInlineWidth
    return undefined
  }
  const frameId = requestAnimationFrame(() => {
    webview.style.width = previousInlineWidth
  })
  return () => {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frameId)
    }
    webview.style.width = previousInlineWidth
  }
}

export function useBrowserPageRemoteDriveRestore({
  browserTabId,
  viewportPresetId,
  isMobileDriven,
  isRemotelyViewed,
  webviewRef
}: {
  browserTabId: string
  viewportPresetId: BrowserViewportPresetId | null
  isMobileDriven: boolean
  isRemotelyViewed: boolean
  webviewRef: React.RefObject<Electron.WebviewTag | null>
}): void {
  useLayoutEffect(() => {
    const preset = getBrowserViewportPreset(viewportPresetId)
    setBrowserPageViewportPresetSize(
      browserTabId,
      preset ? { width: preset.width, height: preset.height } : null
    )
  }, [browserTabId, viewportPresetId])

  const isRemotelyDriven = isMobileDriven || isRemotelyViewed
  const previousRef = useRef<{ tabId: string; remotelyDriven: boolean }>({
    tabId: browserTabId,
    remotelyDriven: isRemotelyDriven
  })

  useEffect(() => {
    const previous = previousRef.current
    previousRef.current = { tabId: browserTabId, remotelyDriven: isRemotelyDriven }
    if (previous.tabId !== browserTabId || !previous.remotelyDriven || isRemotelyDriven) {
      return
    }
    const preset = getBrowserViewportPreset(viewportPresetId)
    setBrowserPageViewportPresetSize(
      browserTabId,
      preset ? { width: preset.width, height: preset.height } : null
    )
    void window.api?.browser
      ?.setViewportOverride?.({
        browserPageId: browserTabId,
        override: preset ? browserViewportPresetToOverride(preset) : null
      })
      ?.catch(() => {})
    // Electron's webview ResizeObserver skips SynchronizeVisualProperties if host CSS bounds stayed constant during mobile emulation.
    return resyncWebviewEmbedderBounds(webviewRef.current as unknown as HTMLElement | null)
  }, [browserTabId, isRemotelyDriven, viewportPresetId, webviewRef])
}
