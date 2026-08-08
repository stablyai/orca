/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: PDF loading drives pdf.js document/viewer instances and decode errors through an external worker lifecycle. */
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Image as ImageIcon, RotateCcw, Search, ZoomIn, ZoomOut } from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import {
  EventBus,
  PDFFindController,
  PDFLinkService,
  PDFViewer as PdfJsViewer
} from 'pdfjs-dist/web/pdf_viewer.mjs'
import 'pdfjs-dist/web/pdf_viewer.css'
import PdfFind from './PdfFind'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { useAppStore } from '@/store'
import { keybindingMatchesAction } from '../../../../shared/keybindings'

import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { translate } from '@/i18n/i18n'
import {
  applyPdfScalePreference,
  stepPdfScalePreference,
  type PdfScalePreference
} from './pdf-scale-preference'
import { pdfViewPositionCache, setWithLRU } from '@/lib/scroll-cache'
import {
  buildPdfScrollDestination,
  clampPdfViewPosition,
  createPdfViewPositionRecorder
} from './pdf-view-position'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const MIN_SCALE = 0.25
const MAX_SCALE = 5
const SCALE_STEP = 1.25
const SCALE_BOUNDS = { min: MIN_SCALE, max: MAX_SCALE, step: SCALE_STEP }

// Why: these are the inputs that actually move this container's scroll; a
// window-level keydown would also fire for typing in an unrelated pane.
const USER_SCROLL_INPUT_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const

type PdfViewerProps = {
  content: string
  filePath: string
  // Why: absent means "no scroll memory" — the diff and conflict-review callers
  // mount several viewers on one path, so a shared key would cross-write.
  scrollCacheKey?: string | null
}

export default function PdfViewer({
  content,
  filePath,
  scrollCacheKey = null
}: PdfViewerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerDivRef = useRef<HTMLDivElement>(null)
  const [pdfError, setPdfError] = useState<string | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [scale, setScale] = useState(1)
  const keybindings = useAppStore((state) => state.keybindings)
  const findShortcutLabel = useShortcutLabel('editor.find')
  const eventBusRef = useRef<InstanceType<typeof EventBus> | null>(null)
  const findControllerRef = useRef<InstanceType<typeof PDFFindController> | null>(null)
  const pdfViewerRef = useRef<InstanceType<typeof PdfJsViewer> | null>(null)
  // Why: content reloads rebuild the pdf.js viewer; keep zoom across updates of
  // the same file, and only reset when the open path changes.
  const scalePreferenceRef = useRef<PdfScalePreference>('page-width')

  const filename = useMemo(() => filePath.split(/[/\\]/).pop() || filePath, [filePath])
  const cleanedContent = useMemo(() => content.replace(/\s/g, ''), [content])

  // Why: reset zoom to fit-width when the open path changes. An effect keeps the
  // reset out of render (refs mutated in render can leak from discarded renders)
  // and covers same-content/different-path opens the load effect skips.
  useEffect(() => {
    scalePreferenceRef.current = 'page-width'
    const viewer = pdfViewerRef.current
    if (viewer) {
      applyPdfScalePreference(viewer, 'page-width', SCALE_BOUNDS)
    }
  }, [filePath])

  useEffect(() => {
    const container = containerRef.current
    const viewerDiv = viewerDivRef.current
    if (!container || !viewerDiv || !cleanedContent) {
      return
    }

    setPdfError(null)
    let cancelled = false

    let binary: string
    try {
      binary = window.atob(cleanedContent)
    } catch {
      setPdfError('Failed to decode PDF content')
      return
    }
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }

    const eventBus = new EventBus()
    eventBusRef.current = eventBus

    const linkService = new PDFLinkService({ eventBus })

    const findController = new PDFFindController({ linkService, eventBus })
    findControllerRef.current = findController

    const viewer = new PdfJsViewer({
      container,
      viewer: viewerDiv,
      eventBus,
      linkService,
      findController,
      textLayerMode: 1,
      removePageBorders: true
    })
    pdfViewerRef.current = viewer

    linkService.setViewer(viewer)

    const handleScaleChanging = (evt: { scale: number }): void => {
      if (!cancelled) {
        setScale(evt.scale)
      }
    }
    eventBus.on('scalechanging', handleScaleChanging)

    // Why: read the key from this effect's own closure, never a ref — the ref
    // would already hold the next file's key by the time this setup runs.
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
      // Why: stays disarmed until the restore settles (below). pdf.js dispatches
      // updateviewarea synchronously after this handler, so arming here would
      // record the restore's own scroll — which on a mixed-page-size document is
      // the provisional, wrong position, and a tab switch before pagesloaded
      // would then flush it over the good cached one.
      for (const type of USER_SCROLL_INPUT_EVENTS) {
        container.addEventListener(type, markUserMoved, { passive: true })
      }
      detachInputWatcher = (): void => {
        detachInputWatcher = null
        for (const type of USER_SCROLL_INPUT_EVENTS) {
          container.removeEventListener(type, markUserMoved)
        }
      }
    }

    let visibilityObserver: ResizeObserver | null = null
    const disconnectVisibilityObserver = (): void => {
      visibilityObserver?.disconnect()
      visibilityObserver = null
    }
    // Why: a display:none pane regaining a layout box fires no scroll or resize
    // event — ResizeObserver's no-box/box transition is the only signal for it.
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

    // Why: pagesinit lays every page out with page 1's dimensions, so on a
    // mixed-page-size document the restore above lands short. pagesloaded is the
    // first point with real per-page heights — but it can arrive seconds later,
    // so re-apply only if the reader has not touched the scroller since.
    const handlePagesLoaded = (): void => {
      // Why: an editor in a background worktree stays mounted under display:none,
      // where pdf.js can neither scroll nor recompute its location. Arming there
      // would let the reader's first zoom persist a page-1 position over the
      // cached one, so stay disarmed — and hold `restored` and the input watcher
      // — until the observer above sees this pane land on screen.
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
        // Why: scrollPageIntoView nulls pdf.js's own `_location` whenever
        // `currentScaleValue` is unset, and it stays unset here because
        // page-width resolves against a not-yet-built page list. A null
        // `_location` makes the next zoom fall back to scrolling the page top,
        // losing the intra-page offset. update() recomputes it; on a
        // uniform-page document the re-apply moves nothing, so no scroll event
        // would otherwise fire to do it for us.
        viewer.update()
      }
      recorder?.arm()
    }

    eventBus.on('pagesinit', handlePagesInit)
    eventBus.on('pagesloaded', handlePagesLoaded)
    eventBus.on('updateviewarea', handleUpdateViewArea)
    // Why: the find controller scrolls to a match programmatically, and the find
    // bar sits outside this container — so a search is reader movement that no
    // input listener above can see.
    eventBus.on('find', markUserMoved)

    const loadingTask = pdfjsLib.getDocument({ data: bytes })

    loadingTask.promise
      .then((doc) => {
        if (cancelled) {
          loadingTask.destroy().catch(() => {})
          return
        }
        viewer.setDocument(doc)
        linkService.setDocument(doc)
        findController.setDocument(doc)
        applyPdfScalePreference(viewer, scalePreferenceRef.current, SCALE_BOUNDS)
      })
      .catch((err) => {
        if (cancelled) {
          return
        }
        if (err?.name === 'PasswordException') {
          setPdfError('This PDF is password-protected')
        } else {
          setPdfError('Failed to load PDF preview')
        }
      })

    return () => {
      cancelled = true
      // Why: flush before setDocument(null) below, so nothing dispatched during
      // pdf.js teardown can overwrite the position we just persisted.
      detachInputWatcher?.()
      disconnectVisibilityObserver()
      recorder?.dispose()
      eventBus.off('pagesinit', handlePagesInit)
      eventBus.off('pagesloaded', handlePagesLoaded)
      eventBus.off('updateviewarea', handleUpdateViewArea)
      eventBus.off('find', markUserMoved)
      setFindOpen(false)
      // Why: pdf.js 6 dropped PDFDocumentProxy.destroy(); destroying the loading
      // task is what tears the document and its worker transport down.
      loadingTask.destroy().catch(() => {})
      // Why: setDocument(null) is the proper teardown — it cancels active
      // renders, clears the find controller, and dispatches pagesdestroy.
      // The runtime accepts null but the types only declare PDFDocumentProxy.
      viewer.setDocument(null as unknown as pdfjsLib.PDFDocumentProxy)
      // Why: pdf.js EventBus retains callbacks by event name; unregister the
      // scale listener so repeated PDF opens do not retain stale component state.
      eventBus.off('scalechanging', handleScaleChanging)
      eventBusRef.current = null
      findControllerRef.current = null
      pdfViewerRef.current = null
    }
    // Why: scrollCacheKey is a dependency because two distinct paths can hold
    // identical bytes — without it this effect would not re-run on the switch,
    // and the second file would restore to the first file's position.
  }, [cleanedContent, scrollCacheKey])

  const closeFindBar = useCallback(() => {
    const eventBus = eventBusRef.current
    if (eventBus) {
      eventBus.dispatch('findbarclose', { source: null })
    }
    setFindOpen(false)
  }, [])

  // Why: every zoom entry point (toolbar + keyboard) must record the scale
  // preference so the next content reload restores it (see scalePreferenceRef).
  const stepZoom = useCallback((direction: 'in' | 'out') => {
    const viewer = pdfViewerRef.current
    if (!viewer) {
      return
    }
    const next = stepPdfScalePreference(viewer.currentScale, direction, SCALE_BOUNDS)
    viewer.currentScale = next.scale
    scalePreferenceRef.current = next.preference
  }, [])

  const zoomIn = useCallback(() => stepZoom('in'), [stepZoom])
  const zoomOut = useCallback(() => stepZoom('out'), [stepZoom])

  const zoomReset = useCallback(() => {
    const viewer = pdfViewerRef.current
    if (!viewer) {
      return
    }
    scalePreferenceRef.current = 'page-width'
    applyPdfScalePreference(viewer, 'page-width', SCALE_BOUNDS)
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const platform = getShortcutPlatform()
      if (keybindingMatchesAction('editor.find', e, platform, keybindings)) {
        e.preventDefault()
        e.stopPropagation()
        setFindOpen(true)
        return
      }
      if (keybindingMatchesAction('zoom.in', e, platform, keybindings)) {
        e.preventDefault()
        zoomIn()
      } else if (keybindingMatchesAction('zoom.out', e, platform, keybindings)) {
        e.preventDefault()
        zoomOut()
      } else if (keybindingMatchesAction('zoom.reset', e, platform, keybindings)) {
        e.preventDefault()
        zoomReset()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [keybindings, zoomIn, zoomOut, zoomReset])

  const zoomPercent = Math.round(scale * 100)

  if (pdfError) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-muted/20 p-8 text-sm text-muted-foreground">
          <ImageIcon size={40} />
          <div>{pdfError}</div>
          <div className="max-w-md break-all text-center text-xs">{filename}</div>
        </div>
        <div className="flex items-center gap-4 border-t px-4 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate" title={filename}>
            {filename}
          </span>
          <span>{translate('auto.components.editor.PdfViewer.3e98d500d2', 'PDF preview')}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex flex-1 flex-col overflow-hidden">
        <PdfFind isOpen={findOpen} onClose={closeFindBar} eventBusRef={eventBusRef} />
        {/* Why: PDFViewer requires its container to be position:absolute.
            The outer div uses all:revert to prevent Tailwind Preflight from
            cascading into pdf.js DOM (text layer misalignment). The inner div
            carries positioning and background since all:revert nullifies classes. */}
        <div style={{ all: 'revert' }}>
          <div
            ref={containerRef}
            style={{
              position: 'absolute',
              inset: '0',
              overflow: 'auto',
              background: 'var(--pdf-viewer-bg, #e4e4e7)'
            }}
            className="scrollbar-editor dark:[--pdf-viewer-bg:#18181b]"
          >
            <div ref={viewerDivRef} className="pdfViewer" />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-4 border-t px-4 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
            onClick={zoomOut}
            disabled={scale <= MIN_SCALE}
            title={translate('auto.components.editor.PdfViewer.fa5d096b00', 'Zoom out')}
          >
            <ZoomOut size={14} />
          </button>
          <button
            type="button"
            className="rounded p-1 hover:bg-accent hover:text-foreground"
            onClick={zoomReset}
            title={translate('auto.components.editor.PdfViewer.c0119616d6', 'Fit to width')}
          >
            <RotateCcw size={14} />
          </button>
          <button
            type="button"
            className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
            onClick={zoomIn}
            disabled={scale >= MAX_SCALE}
            title={translate('auto.components.editor.PdfViewer.2b6eb1ccd6', 'Zoom in')}
          >
            <ZoomIn size={14} />
          </button>
          <span className="ml-1 tabular-nums">{zoomPercent}%</span>
        </div>
        <button
          type="button"
          className="rounded p-1 hover:bg-accent hover:text-foreground"
          onClick={() => setFindOpen(true)}
          title={translate(
            'auto.components.editor.PdfViewer.069ff59932',
            'Find in PDF ({{value0}})',
            { value0: findShortcutLabel }
          )}
        >
          <Search size={14} />
        </button>
        <span className="min-w-0 truncate" title={filename}>
          {filename}
        </span>
        <span>{translate('auto.components.editor.PdfViewer.3e98d500d2', 'PDF preview')}</span>
      </div>
    </div>
  )
}
