import type * as pdfjsLib from 'pdfjs-dist'
import {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer as PdfJsViewer
} from 'pdfjs-dist/web/pdf_viewer.mjs'
import { applyPdfScalePreference, type PdfScalePreference } from './pdf-scale-preference'
import { pdfViewPositionCache, setWithLRU } from '@/lib/scroll-cache'
import {
  buildPdfScrollDestination,
  clampPdfViewPosition,
  createPdfViewPositionRecorder
} from './pdf-view-position'

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
  scalePreference,
  scaleBounds,
  onScaleChanging
}: {
  container: HTMLDivElement
  viewerDiv: HTMLDivElement
  doc: pdfjsLib.PDFDocumentProxy
  scrollCacheKey: string | null
  scalePreference: PdfScalePreference
  scaleBounds: { min: number; max: number }
  onScaleChanging: (scale: number) => void
}): {
  viewer: InstanceType<typeof PdfJsViewer>
  eventBus: InstanceType<typeof EventBus>
  findController: InstanceType<typeof PDFFindController>
  dispose: () => void
} {
  let cancelled = false
  const eventBus = new EventBus()

  const linkService = new PDFLinkService({ eventBus })

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

  // Why: each displayed document owns its scroll recorder and cache key.
  const recorder = scrollCacheKey
    ? createPdfViewPositionRecorder({
        key: scrollCacheKey,
        write: (key, position) => setWithLRU(pdfViewPositionCache, key, position)
      })
    : null

  const handleUpdateViewArea = (evt: { location?: unknown }): void => {
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

  const handlePagesInit = (): void => {
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
    recorder?.dispose()
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
    applyPdfScalePreference(viewer, scalePreference, scaleBounds)
  } catch (error) {
    dispose()
    throw error
  }
  return { viewer, eventBus, findController, dispose }
}
