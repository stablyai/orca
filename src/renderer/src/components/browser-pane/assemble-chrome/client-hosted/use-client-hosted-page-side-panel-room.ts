import { useLayoutEffect, useRef } from 'react'
import { rememberBrowserPageChromeInsetHeight } from '../../host-guest/viewport/browser-page-chrome-inset-heights'
import { BROWSER_SIDE_PANEL_WIDTH_VARIABLE } from '../../host-guest/viewport/browser-page-viewport'

const SIDE_PANEL_ROOM_STYLE = { marginRight: `var(${BROWSER_SIDE_PANEL_WIDTH_VARIABLE}, 0px)` }

/**
 * Props for a This-device page's area below its chrome, leaving room for an extension side panel
 * as a local page's shell does: the page gives up the panel's width, the panel docks below chrome.
 */
export function useClientHostedPageSidePanelRoom(browserPageId: string): {
  ref: React.RefObject<HTMLDivElement | null>
  style: React.CSSProperties
} {
  const pageAreaRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const pageArea = pageAreaRef.current
    if (!pageArea) {
      return
    }
    // Why the page area's offset: it moves whenever the toolbar or a banner above it resizes.
    const sync = (): void => {
      rememberBrowserPageChromeInsetHeight(browserPageId, pageArea.offsetTop)
    }
    sync()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync)
    observer?.observe(pageArea)
    return () => observer?.disconnect()
  }, [browserPageId])
  return { ref: pageAreaRef, style: SIDE_PANEL_ROOM_STYLE }
}
