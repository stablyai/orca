import { useEffect, useLayoutEffect, type RefObject } from 'react'
import type { BrowserViewportPresetId } from '../../../../shared/browser-workspace-types'
import {
  browserViewportPresetToOverride,
  getBrowserViewportPreset
} from '../../../../shared/browser-viewport-presets'
import { applyViewportPresetSizeStyles } from './host-guest/browser-page-viewport'
import { useBrowserPageViewportScrollReporting } from './host-guest/use-browser-page-viewport-scroll-reporting'

export function useClientHostedBrowserViewport({
  browserPageId,
  presetId,
  pageHostGeneration,
  contentRef,
  scrollerRef,
  webviewRef
}: {
  browserPageId: string
  presetId: BrowserViewportPresetId | null
  pageHostGeneration: number | null
  contentRef: RefObject<HTMLDivElement | null>
  scrollerRef: RefObject<HTMLDivElement | null>
  webviewRef: RefObject<Electron.WebviewTag | null>
}): void {
  useBrowserPageViewportScrollReporting(browserPageId, null, presetId, scrollerRef)
  useEffect(() => {
    const scroller = scrollerRef.current
    const subscribe = window.api.ui?.onScrollBrowserPage
    if (!scroller || !subscribe || !presetId) {
      return
    }
    return subscribe((event) => {
      if (event.browserPageId !== browserPageId) {
        return
      }
      scroller.scrollLeft += event.deltaX
      scroller.scrollTop += event.deltaY
    })
  }, [browserPageId, presetId, scrollerRef])
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroller = scrollerRef.current
    if (!content || !scroller) {
      return
    }
    const preset = getBrowserViewportPreset(presetId)
    applyViewportPresetSizeStyles({ content, scroller }, preset)
  }, [presetId, contentRef, scrollerRef])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview || pageHostGeneration === null) {
      return
    }
    const apply = (): void => {
      const preset = getBrowserViewportPreset(presetId)
      void window.api.browser.setViewportOverride({
        browserPageId,
        override: preset ? browserViewportPresetToOverride(preset) : null
      })
    }
    apply()
    webview.addEventListener('dom-ready', apply)
    return () => {
      webview.removeEventListener('dom-ready', apply)
    }
  }, [browserPageId, presetId, pageHostGeneration, webviewRef])
}
