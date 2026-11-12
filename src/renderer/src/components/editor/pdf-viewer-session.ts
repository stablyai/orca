import type * as pdfjsLib from 'pdfjs-dist'
import {
  type EventBus,
  PDFFindController,
  PDFViewer as PdfJsViewer
} from 'pdfjs-dist/web/pdf_viewer.mjs'
import {
  applyPdfScalePreference,
  zoomPdfViewerWithWheel,
  type PdfScalePreference
} from './pdf-scale-preference'
import {
  pdfViewPositionCache,
  setWithLRU
} from '@/components/editor/model-lifetime/retention/editor-view-state-cache'
import {
  buildPdfScrollDestination,
  clampPdfViewPosition,
  createPdfViewPositionRecorder
} from './pdf-view-position'
import {
  attachPdfLinkHistory,
  createLinkFocusTrackingEventBus,
  HistoryAwarePdfLinkService,
  type PdfViewerLinkHistory
} from './pdf-link-navigation'

const PAGE_WIDTH_REFIT_SETTLE_MS = 150

const USER_SCROLL_INPUT_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const

function watchUserScrollInput(container: HTMLElement, onInput: () => void): () => void {
  for (const type of USER_SCROLL_INPUT_EVENTS) {
    container.addEventListener(type, onInput, { passive: true })
  }
  return () => {
    for (const type of USER_SCROLL_INPUT_EVENTS) {
      container.removeEventListener(type, onInput)
    }
  }
}

export function createPdfViewerSession({
  container,
  viewerDiv,
  doc,
  scrollCacheKey,
  getScalePreference,
  scaleBounds,
  onScaleChanging,
  onWheelZoom
}: {
  container: HTMLDivElement
  viewerDiv: HTMLDivElement
  doc: pdfjsLib.PDFDocumentProxy
  scrollCacheKey: string | null
  getScalePreference: () => PdfScalePreference
  scaleBounds: { min: number; max: number }
  onScaleChanging: (scale: number) => void
  onWheelZoom: (scale: PdfScalePreference) => void
}): {
  viewer: InstanceType<typeof PdfJsViewer>
  eventBus: InstanceType<typeof EventBus>
  findController: InstanceType<typeof PDFFindController>
  linkHistory: PdfViewerLinkHistory
  dispose: () => void
} {
  let cancelled = false
  const { eventBus, cancelPendingLinkTargetFocus } = createLinkFocusTrackingEventBus()
  const linkService = new HistoryAwarePdfLinkService({ eventBus })

  const findController = new PDFFindController({ linkService, eventBus })

  const abortController = new AbortController()
  const viewerOptions = {
    container,
    viewer: viewerDiv,
    eventBus,
    linkService,
    findController,
    textLayerMode: 1,
    removePageBorders: true,
    abortSignal: abortController.signal
  }
  const viewer = new PdfJsViewer(viewerOptions)

  linkService.setViewer(viewer)

  const handleScaleChanging = (evt: { scale: number }): void => {
    if (!cancelled) {
      onScaleChanging(evt.scale)
    }
  }
  eventBus.on('scalechanging', handleScaleChanging)

  // Why: Chromium reports trackpad pinch as ctrl-wheel; unclaimed, it only scrolls the PDF.
  container.addEventListener(
    'wheel',
    (event) => {
      const preference = zoomPdfViewerWithWheel(viewer, event, scaleBounds, () => {
        const page = viewer.getPageView(viewer.currentPageNumber - 1)
        // Why: pdf.js's 'page-width' scale, given removePageBorders (no padding) and no spreads.
        return page ? (container.clientWidth / page.width) * page.scale : null
      })
      if (preference !== null) {
        onWheelZoom(preference)
      }
    },
    { passive: false, signal: abortController.signal }
  )

  // Why: each displayed document owns its scroll recorder and cache key.
  const recorder = scrollCacheKey
    ? createPdfViewPositionRecorder({
        key: scrollCacheKey,
        write: (key, position) => setWithLRU(pdfViewPositionCache, key, position)
      })
    : null

  const handleUpdateViewArea = (evt: { location?: unknown }): void => {
    linkNavigation.recordViewArea(evt?.location)
    recorder?.record(evt?.location)
  }

  let restored: ReturnType<typeof buildPdfScrollDestination> | null = null
  let userMoved = false
  let detachInputWatcher: (() => void) | null = null
  const markUserMoved = (): void => {
    userMoved = true
    detachInputWatcher?.()
    recorder?.arm()
  }

  const linkNavigation = attachPdfLinkHistory({
    viewer,
    linkService,
    cancelPendingLinkTargetFocus,
    isActive: () => !cancelled,
    onReaderMoved: markUserMoved
  })

  const handlePagesInit = (): void => {
    // Why: pdf.js drops a preset scale set before its page views exist, leaving the PDF at 100%.
    applyPdfScalePreference(viewer, getScalePreference(), scaleBounds)
    const cached = scrollCacheKey ? pdfViewPositionCache.get(scrollCacheKey) : undefined
    const clamped = cached ? clampPdfViewPosition(cached, viewer.pagesCount) : null
    if (!clamped) {
      recorder?.arm()
      return
    }
    restored = buildPdfScrollDestination(clamped)
    viewer.scrollPageIntoView(restored)
    // Why: provisional restore events must not overwrite the cached position.
    const detach = watchUserScrollInput(container, markUserMoved)
    detachInputWatcher = (): void => {
      detachInputWatcher = null
      detach()
    }
  }

  let visibilityObserver: ResizeObserver | null = null
  const disconnectVisibilityObserver = (): void => {
    visibilityObserver?.disconnect()
    visibilityObserver = null
  }
  // Why: a hidden pane becoming visible fires no scroll or resize event.
  const observeVisibility = (): void => {
    if (visibilityObserver) {
      return
    }
    visibilityObserver = new ResizeObserver(() => {
      if (container.clientHeight > 0) {
        handlePagesLoaded()
      }
    })
    visibilityObserver.observe(container)
  }

  // Why: restore again with real page heights unless the reader already moved.
  const handlePagesLoaded = (): void => {
    // Why: a hidden viewer cannot restore; keep its recorder disarmed until visible.
    if (container.clientHeight === 0) {
      observeVisibility()
      return
    }
    disconnectVisibilityObserver()
    const destination = restored
    restored = null
    detachInputWatcher?.()
    if (cancelled) {
      return
    }
    if (destination && !userMoved) {
      viewer.scrollPageIntoView(destination)
      // Why: recompute pdf.js's location so the next zoom preserves the intra-page offset.
      viewer.update()
    }
    recorder?.arm()
  }

  // Why: pdf.js computes 'page-width' once; split resizes and maximize must refit it.
  let refitTimer: ReturnType<typeof setTimeout> | null = null
  const refitPageWidth = (): void => {
    refitTimer = null
    // Why: a hidden pane measures zero wide and would fit the pages to nothing.
    if (
      container.clientWidth > 0 &&
      viewer.pagesCount > 0 &&
      viewer.currentScaleValue === 'page-width'
    ) {
      viewer.currentScaleValue = 'page-width'
    }
  }
  const fitWidthObserver = new ResizeObserver(() => {
    // Why: each refit re-renders the visible pages, so wait for a split drag to settle.
    if (refitTimer !== null) {
      clearTimeout(refitTimer)
    }
    refitTimer = setTimeout(refitPageWidth, PAGE_WIDTH_REFIT_SETTLE_MS)
  })
  // Why: border-box ignores the scrollbar a refit can toggle, which would refit again in a loop.
  fitWidthObserver.observe(container, { box: 'border-box' })

  eventBus.on('pagesinit', handlePagesInit)
  eventBus.on('pagesloaded', handlePagesLoaded)
  eventBus.on('updateviewarea', handleUpdateViewArea)
  // Why: finding a match moves the reader without input on the scroll container.
  eventBus.on('find', markUserMoved)

  const dispose = (): void => {
    if (cancelled) {
      return
    }
    cancelled = true
    // Why: teardown events must not overwrite the reader's final position.
    detachInputWatcher?.()
    disconnectVisibilityObserver()
    fitWidthObserver.disconnect()
    if (refitTimer !== null) {
      clearTimeout(refitTimer)
    }
    recorder?.dispose()
    cancelPendingLinkTargetFocus()
    eventBus.off('pagesinit', handlePagesInit)
    eventBus.off('pagesloaded', handlePagesLoaded)
    eventBus.off('updateviewarea', handleUpdateViewArea)
    eventBus.off('find', markUserMoved)
    eventBus.off('scalechanging', handleScaleChanging)
    // Why: detach cancels renders and clears the find controller before worker destruction.
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pdf.js accepts null to detach a document, but its declaration omits null.
      viewer.setDocument(null as unknown as pdfjsLib.PDFDocumentProxy)
    } finally {
      // Why: setDocument(null) does not release pdf.js's scroll listener and ResizeObserver.
      abortController.abort()
      // Why: the default localization service owns a separate MutationObserver.
      void viewer.l10n?.destroy().catch(() => {})
    }
  }
  try {
    viewer.setDocument(doc)
    linkService.setDocument(doc)
    findController.setDocument(doc)
    applyPdfScalePreference(viewer, getScalePreference(), scaleBounds)
  } catch (error) {
    dispose()
    throw error
  }
  return {
    viewer,
    eventBus,
    findController,
    linkHistory: linkNavigation.linkHistory,
    dispose
  }
}
