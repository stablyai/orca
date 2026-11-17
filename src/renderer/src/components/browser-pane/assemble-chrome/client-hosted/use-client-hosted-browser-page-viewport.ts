import { useEffect, useLayoutEffect, useState } from 'react'
import type { BrowserViewportPresetId } from '../../../../../../shared/browser/workspaces/browser-workspace-types'
import {
  browserViewportPresetToOverride,
  getBrowserViewportPreset
} from '../../../../../../shared/browser/guest-lifecycle/browser-viewport-presets'
import { applyViewportPresetSizeStyles } from '../../host-guest/viewport/browser-page-viewport'
import { useBrowserPageViewportScrollReporting } from '../../host-guest/viewport/use-browser-page-viewport-scroll-reporting'

/** Sends the page's preset to its guest; CDP overrides don't survive a cross-origin load, so callers reapply on dom-ready. */
export function applyClientHostedBrowserViewportOverride(
  browserPageId: string,
  presetId: BrowserViewportPresetId | null
): void {
  const preset = getBrowserViewportPreset(presetId)
  void window.api.browser.setViewportOverride({
    browserPageId,
    override: preset ? browserViewportPresetToOverride(preset) : null
  })
}

/** Sizes the page box to its viewport preset as a local page's box is sized, and pans it like one. */
export function useClientHostedBrowserPageViewport(
  browserPageId: string,
  presetId: BrowserViewportPresetId | null
): {
  /** The box the guest attaches to: the scroller's size, or the preset's. */
  content: HTMLDivElement | null
  setScroller: (element: HTMLDivElement | null) => void
  setContent: (element: HTMLDivElement | null) => void
} {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!scroller || !content) {
      return
    }
    const preset = getBrowserViewportPreset(presetId)
    applyViewportPresetSizeStyles(
      { scroller, content },
      preset ? { width: preset.width, height: preset.height } : null
    )
  }, [scroller, content, presetId])
  useBrowserPageViewportScrollReporting(browserPageId, scroller, presetId)
  useEffect(() => {
    // Main sends these only while a preset outsizes the pane.
    const subscribe = window.api.ui.onScrollBrowserPage
    if (!subscribe || !scroller) {
      return
    }
    return subscribe((event) => {
      if (event.browserPageId === browserPageId) {
        scroller.scrollLeft += event.deltaX
        scroller.scrollTop += event.deltaY
      }
    })
  }, [browserPageId, scroller])
  return { content, setScroller, setContent }
}
