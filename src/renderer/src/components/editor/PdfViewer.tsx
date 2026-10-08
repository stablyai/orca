/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: PDF loading drives pdf.js document/viewer instances and decode errors through an external worker lifecycle. */
import { type JSX, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Image as ImageIcon, RotateCcw, Search, ZoomIn, ZoomOut } from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist'
import type {
  EventBus,
  PDFFindController,
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
import { createPdfDocumentLoader, type PdfDocumentLoader } from './pdf-document-loader'
import { createPdfViewerSession } from './pdf-viewer-session'
import {
  applyPdfScalePreference,
  stepPdfScalePreference,
  type PdfScalePreference
} from './pdf-scale-preference'
import { readPdfScalePreference, writePdfScalePreference } from './pdf-scale-preference-storage'
import { EditorCommandOwnerContext } from './editor-command-owner-context'
import { listenForPdfZoomRequests } from './pdf-zoom-request'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const MIN_SCALE = 0.25
const MAX_SCALE = 5
const SCALE_STEP = 1.25
const SCALE_BOUNDS = { min: MIN_SCALE, max: MAX_SCALE, step: SCALE_STEP }

type PdfViewerProps = {
  content: string
  filePath: string
  // Why: callers that do not have an owner identity (for example diff and
  // conflict panes) must not persist a preference under a path-only key.
  preferenceKey?: string | null
  // Why: absent means "no scroll memory" — the diff and conflict-review callers
  // mount several viewers on one path, so a shared key would cross-write.
  scrollCacheKey?: string | null
}

export default function PdfViewer(props: PdfViewerProps): JSX.Element {
  const identity = JSON.stringify([
    props.filePath,
    props.preferenceKey ?? null,
    props.scrollCacheKey ?? null
  ])
  return <PdfDocumentViewer key={identity} {...props} />
}

function PdfDocumentViewer({
  content,
  filePath,
  preferenceKey = null,
  scrollCacheKey = null
}: PdfViewerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerDivRef = useRef<HTMLDivElement>(null)
  const loaderRef = useRef<PdfDocumentLoader | null>(null)
  const [pdfError, setPdfError] = useState<string | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [scale, setScale] = useState(1)
  const keybindings = useAppStore((state) => state.keybindings)
  const findShortcutLabel = useShortcutLabel('editor.find')
  const isCommandOwner = useContext(EditorCommandOwnerContext)
  const eventBusRef = useRef<InstanceType<typeof EventBus> | null>(null)
  const findControllerRef = useRef<InstanceType<typeof PDFFindController> | null>(null)
  const pdfViewerRef = useRef<InstanceType<typeof PdfJsViewer> | null>(null)
  // Why: content reloads rebuild the pdf.js viewer; keep zoom across updates of
  // the same file and restore the durable preference after a remount or restart.
  const scalePreferenceRef = useRef<PdfScalePreference>('page-width')

  const filename = useMemo(() => filePath.split(/[/\\]/).pop() || filePath, [filePath])
  const cleanedContent = useMemo(() => content.replace(/\s/g, ''), [content])

  // Why: every zoom entry point (toolbar, app zoom command, wheel/pinch) must record the
  // scale preference so the next content reload restores it (see scalePreferenceRef).
  const recordScalePreference = useCallback(
    (preference: PdfScalePreference) => {
      scalePreferenceRef.current = preference
      if (preferenceKey) {
        writePdfScalePreference(preferenceKey, preference)
      }
    },
    [preferenceKey]
  )

  useEffect(() => {
    const container = containerRef.current
    const viewerDiv = viewerDivRef.current
    if (!container || !viewerDiv) {
      return
    }

    setPdfError(null)
    scalePreferenceRef.current = preferenceKey
      ? (readPdfScalePreference(preferenceKey) ?? 'page-width')
      : 'page-width'
    const loader = createPdfDocumentLoader({
      onError: setPdfError,
      display: (doc) => {
        const session = createPdfViewerSession({
          container,
          viewerDiv,
          doc,
          scrollCacheKey,
          scalePreference: scalePreferenceRef.current,
          scaleBounds: SCALE_BOUNDS,
          onScaleChanging: setScale,
          onWheelZoom: recordScalePreference
        })
        eventBusRef.current = session.eventBus
        findControllerRef.current = session.findController
        pdfViewerRef.current = session.viewer
        return () => {
          try {
            session.dispose()
          } finally {
            eventBusRef.current = null
            findControllerRef.current = null
            pdfViewerRef.current = null
            setFindOpen(false)
          }
        }
      }
    })
    loaderRef.current = loader
    return () => {
      loaderRef.current = null
      loader.dispose()
    }
  }, [filePath, preferenceKey, recordScalePreference, scrollCacheKey])

  useEffect(() => {
    loaderRef.current?.load(cleanedContent)
    // Why: owner changes must load again even when the bytes are identical.
  }, [cleanedContent, filePath, preferenceKey, scrollCacheKey])

  const closeFindBar = useCallback(() => {
    const eventBus = eventBusRef.current
    if (eventBus) {
      eventBus.dispatch('findbarclose', { source: null })
    }
    setFindOpen(false)
  }, [])

  const stepZoom = useCallback(
    (direction: 'in' | 'out') => {
      const viewer = pdfViewerRef.current
      if (!viewer) {
        return
      }
      const next = stepPdfScalePreference(viewer.currentScale, direction, SCALE_BOUNDS)
      viewer.currentScale = next.scale
      recordScalePreference(next.preference)
    },
    [recordScalePreference]
  )

  const zoomIn = useCallback(() => stepZoom('in'), [stepZoom])
  const zoomOut = useCallback(() => stepZoom('out'), [stepZoom])

  const zoomReset = useCallback(() => {
    const viewer = pdfViewerRef.current
    if (!viewer) {
      return
    }
    applyPdfScalePreference(viewer, 'page-width', SCALE_BOUNDS)
    recordScalePreference('page-width')
  }, [recordScalePreference])

  useEffect(() => {
    if (!isCommandOwner) {
      return
    }
    return listenForPdfZoomRequests((direction) =>
      direction === 'reset' ? zoomReset() : stepZoom(direction)
    )
  }, [isCommandOwner, stepZoom, zoomReset])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const platform = getShortcutPlatform()
      if (keybindingMatchesAction('editor.find', e, platform, keybindings)) {
        e.preventDefault()
        e.stopPropagation()
        setFindOpen(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [keybindings])

  const zoomPercent = Math.round(scale * 100)

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
        {pdfError ? (
          <div
            role="alert"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-8 text-sm text-muted-foreground"
          >
            <ImageIcon size={40} />
            <div>{pdfError}</div>
            <div className="max-w-md break-all text-center text-xs">{filename}</div>
          </div>
        ) : null}
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
