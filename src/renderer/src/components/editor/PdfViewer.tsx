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

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const MIN_SCALE = 0.25
const MAX_SCALE = 5
const SCALE_STEP = 1.25

type PdfViewerProps = {
  content: string
  filePath: string
}

export default function PdfViewer({ content, filePath }: PdfViewerProps): JSX.Element {
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

  const filename = useMemo(() => filePath.split(/[/\\]/).pop() || filePath, [filePath])
  const cleanedContent = useMemo(() => content.replace(/\s/g, ''), [content])

  useEffect(() => {
    const container = containerRef.current
    const viewerDiv = viewerDivRef.current
    if (!container || !viewerDiv || !cleanedContent) {
      return
    }

    setPdfError(null)
    let cancelled = false
    let pdfDocument: pdfjsLib.PDFDocumentProxy | null = null

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

    const loadingTask = pdfjsLib.getDocument({ data: bytes })

    loadingTask.promise
      .then((doc) => {
        if (cancelled) {
          doc.destroy()
          return
        }
        pdfDocument = doc
        viewer.setDocument(doc)
        linkService.setDocument(doc)
        findController.setDocument(doc)
        viewer.currentScaleValue = 'page-width'
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
      setFindOpen(false)
      loadingTask.destroy().catch(() => {})
      if (pdfDocument) {
        pdfDocument.destroy()
      }
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
  }, [cleanedContent])

  const closeFindBar = useCallback(() => {
    const eventBus = eventBusRef.current
    if (eventBus) {
      eventBus.dispatch('findbarclose', { source: null })
    }
    setFindOpen(false)
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
        const viewer = pdfViewerRef.current
        if (viewer) {
          viewer.currentScale = Math.min(MAX_SCALE, viewer.currentScale * SCALE_STEP)
        }
      } else if (keybindingMatchesAction('zoom.out', e, platform, keybindings)) {
        e.preventDefault()
        const viewer = pdfViewerRef.current
        if (viewer) {
          viewer.currentScale = Math.max(MIN_SCALE, viewer.currentScale / SCALE_STEP)
        }
      } else if (keybindingMatchesAction('zoom.reset', e, platform, keybindings)) {
        e.preventDefault()
        const viewer = pdfViewerRef.current
        if (viewer) {
          viewer.currentScaleValue = 'page-width'
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [keybindings])

  const zoomIn = useCallback(() => {
    const viewer = pdfViewerRef.current
    if (viewer) {
      viewer.currentScale = Math.min(MAX_SCALE, viewer.currentScale * SCALE_STEP)
    }
  }, [])

  const zoomOut = useCallback(() => {
    const viewer = pdfViewerRef.current
    if (viewer) {
      viewer.currentScale = Math.max(MIN_SCALE, viewer.currentScale / SCALE_STEP)
    }
  }, [])

  const zoomReset = useCallback(() => {
    const viewer = pdfViewerRef.current
    if (viewer) {
      viewer.currentScaleValue = 'page-width'
    }
  }, [])

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
          <span>{translate("auto.components.editor.PdfViewer.3e98d500d2", "PDF preview")}</span>
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
            title={translate("auto.components.editor.PdfViewer.fa5d096b00", "Zoom out")}
          >
            <ZoomOut size={14} />
          </button>
          <button
            type="button"
            className="rounded p-1 hover:bg-accent hover:text-foreground"
            onClick={zoomReset}
            title={translate("auto.components.editor.PdfViewer.c0119616d6", "Fit to width")}
          >
            <RotateCcw size={14} />
          </button>
          <button
            type="button"
            className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
            onClick={zoomIn}
            disabled={scale >= MAX_SCALE}
            title={translate("auto.components.editor.PdfViewer.2b6eb1ccd6", "Zoom in")}
          >
            <ZoomIn size={14} />
          </button>
          <span className="ml-1 tabular-nums">{zoomPercent}%</span>
        </div>
        <button
          type="button"
          className="rounded p-1 hover:bg-accent hover:text-foreground"
          onClick={() => setFindOpen(true)}
          title={translate("auto.components.editor.PdfViewer.069ff59932", "Find in PDF ({{value0}})", { value0: findShortcutLabel })}
        >
          <Search size={14} />
        </button>
        <span className="min-w-0 truncate" title={filename}>
          {filename}
        </span>
        <span>{translate("auto.components.editor.PdfViewer.3e98d500d2", "PDF preview")}</span>
      </div>
    </div>
  )
}
