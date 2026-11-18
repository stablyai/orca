import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
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
function applyClientHostedBrowserViewportOverride(
  browserPageId: string,
  presetId: BrowserViewportPresetId | null,
  scroller: HTMLElement | null,
  trigger: 'attach' | 'load'
): void {
  const preset = getBrowserViewportPreset(presetId)
  // A pane remount must not clear a viewport an agent set on the retained guest; a load resets it, as on a local page.
  if (!preset && trigger === 'attach') {
    return
  }
  void window.api.browser
    .setViewportOverride({
      browserPageId,
      override: preset ? browserViewportPresetToOverride(preset) : null
    })
    .then(() => {
      // Main drops wheel bounds on every override, and a reapplied preset resizes nothing that would re-report them.
      if (scroller?.isConnected) {
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
  applyOverride: (trigger: 'attach' | 'load') => void
} {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const presetIdRef = useRef(presetId)
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    presetIdRef.current = presetId
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
  const applyOverride = useCallback(
    (trigger: 'attach' | 'load') =>
      applyClientHostedBrowserViewportOverride(
        browserPageId,
        presetIdRef.current,
        scrollerRef.current,
        trigger
      ),
    [browserPageId]
  )
  return { scrollerRef, contentRef, applyOverride }
}

/** The scroller and preset-sized box the guest attaches to; children such as the drawing screenshot share the guest's box. */
export function ClientHostedBrowserPageBox({
  scrollerRef,
  contentRef,
  children
}: {
  scrollerRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      ref={scrollerRef}
      data-browser-page-scroller=""
      className="scrollbar-sleek absolute inset-0 overflow-hidden"
    >
      <div ref={contentRef} className="relative mx-auto">
        {children}
      </div>
    </div>
  )
}
