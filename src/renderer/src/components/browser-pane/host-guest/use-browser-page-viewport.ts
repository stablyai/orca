import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from 'react'
import { getBrowserViewportPreset } from '../../../../../shared/browser-viewport-presets'
import type { BrowserViewportPresetId } from '../../../../../shared/browser-workspace-types'
import {
  ensureBrowserPageViewport,
  scrollBrowserPageViewport,
  setBrowserPageViewportPresetSize
} from './browser-page-viewport'
import { useBrowserPageSlotViewport } from './use-browser-page-slot-viewport'
import { useBrowserPageViewportScrollReporting } from './use-browser-page-viewport-scroll-reporting'

export function useBrowserPageViewport(
  browserPageId: string,
  workspaceId: string,
  viewportPresetId: BrowserViewportPresetId | null
): {
  pageViewport: ReturnType<typeof ensureBrowserPageViewport>
  containerRef: MutableRefObject<HTMLDivElement | null>
  slotViewport: HTMLDivElement | null
} {
  const slotViewport = useBrowserPageSlotViewport(workspaceId)
  const pageViewport = ensureBrowserPageViewport(browserPageId, workspaceId)
  const container = pageViewport?.container ?? null
  const scroller = pageViewport?.scroller ?? null
  const containerRef = useRef(container)
  useLayoutEffect(() => {
    containerRef.current = container
  }, [container])
  useLayoutEffect(() => {
    const preset = getBrowserViewportPreset(viewportPresetId)
    setBrowserPageViewportPresetSize(
      browserPageId,
      preset ? { width: preset.width, height: preset.height } : null
    )
  }, [browserPageId, viewportPresetId])
  useBrowserPageViewportScrollReporting(browserPageId, scroller, viewportPresetId)
  useEffect(() => {
    const subscribe = window.api.ui.onScrollBrowserPage
    if (!subscribe || !scroller || !viewportPresetId) {
      return
    }
    return subscribe((event) => {
      if (event.browserPageId === browserPageId) {
        scrollBrowserPageViewport(browserPageId, event.deltaX, event.deltaY)
      }
    })
  }, [browserPageId, scroller, viewportPresetId])
  return { pageViewport, containerRef, slotViewport }
}
