import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { BrowserViewportPresetId } from '../../../../../../shared/browser/workspaces/browser-workspace-types'
import {
  browserViewportPresetToOverride,
  getBrowserViewportPreset
} from '../../../../../../shared/browser/guest-lifecycle/browser-viewport-presets'
import {
  applyViewportPresetSizeStyles,
  readBrowserPageViewportScrollState
} from '../../host-guest/viewport/browser-page-viewport'
import { useBrowserPageViewportScrollReporting } from '../../host-guest/viewport/use-browser-page-viewport-scroll-reporting'

/** Sends the page's preset to its guest; CDP overrides don't survive a cross-origin load, so callers reapply on dom-ready. */
export function applyClientHostedBrowserViewportOverride(
  browserPageId: string,
  presetId: BrowserViewportPresetId | null,
  scroller: HTMLElement | null
): void {
  const preset = getBrowserViewportPreset(presetId)
  void window.api.browser
    .setViewportOverride({
      browserPageId,
      override: preset ? browserViewportPresetToOverride(preset) : null
    })
    .then(() => {
      // Main drops wheel bounds on every override, and a reapplied preset resizes nothing that would re-report them.
      if (scroller) {
        window.api.browser.reportViewportScrollState?.({
          browserPageId,
          state: readBrowserPageViewportScrollState(scroller)
        })
      }
    })
}

/** Sizes the page box to its viewport preset as a local page's box is sized, and pans it like one. */
export function useClientHostedBrowserPageViewport(
  browserPageId: string,
  presetId: BrowserViewportPresetId | null
): {
  scrollerRef: RefObject<HTMLDivElement | null>
  /** The box the guest attaches to: the scroller's size, or the preset's. Refs, so the guest attaches in the pane's first commit. */
  contentRef: RefObject<HTMLDivElement | null>
} {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const content = contentRef.current
    if (!scroller || !content) {
      return
    }
    const preset = getBrowserViewportPreset(presetId)
    applyViewportPresetSizeStyles(
      { scroller, content },
      preset ? { width: preset.width, height: preset.height } : null
    )
  }, [presetId])
  useLayoutEffect(() => setScroller(scrollerRef.current), [])
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
  return { scrollerRef, contentRef }
}

/** The scroller and preset-sized box the guest attaches to, with what must share the guest's box. */
export function ClientHostedBrowserPageBox({
  box,
  children
}: {
  box: ReturnType<typeof useClientHostedBrowserPageViewport>
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      ref={box.scrollerRef}
      data-browser-page-scroller=""
      className="scrollbar-sleek absolute inset-0 overflow-hidden"
    >
      <div ref={box.contentRef} className="relative mx-auto">
        {children}
      </div>
    </div>
  )
}
