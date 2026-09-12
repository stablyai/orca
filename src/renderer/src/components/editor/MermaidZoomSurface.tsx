import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import MermaidBlock from './MermaidBlock'
import {
  type SurfacePanOrigin,
  getPannedScrollOffsets,
  shouldStartSurfacePan
} from './surface-drag-pan'
import {
  type ApplySurfaceZoomChange,
  applyAnchoredSurfaceZoomChange,
  applySurfaceWheel,
  getElementSurfaceSize,
  getSurfaceLayoutStyle
} from './surface-dom-zoom'
import {
  MAX_SURFACE_ZOOM,
  MIN_SURFACE_ZOOM,
  SURFACE_ZOOM_STEP,
  type SurfaceContentDimensions,
  type SurfaceSize,
  getZoomedSurfaceLayoutSize
} from './surface-zoom'

// Why: must match the .mermaid-viewer-canvas padding, or the fitted diagram
// overflows the surface at 100% and reports itself as pannable.
const MERMAID_CANVAS_PADDING = 24

type MermaidZoomSurfaceProps = {
  content: string
  isDark: boolean
  // Why: the caller owns scroll-position memory, so it needs the same element
  // this surface scrolls and zooms.
  surfaceRef?: React.RefObject<HTMLDivElement | null>
}

/**
 * Scroll-and-zoom surface for a rendered mermaid diagram. Zoom resizes the
 * diagram's layout box rather than transforming it, so scroll extents grow with
 * zoom and panning reaches the whole diagram.
 */
export default function MermaidZoomSurface({
  content,
  isDark,
  surfaceRef
}: MermaidZoomSurfaceProps): React.JSX.Element {
  const [zoom, setZoom] = useState(1)
  const [surfaceSize, setSurfaceSize] = useState<SurfaceSize | null>(null)
  const [diagramSize, setDiagramSize] = useState<SurfaceContentDimensions | null>(null)
  const localSurfaceRef = useRef<HTMLDivElement | null>(null)
  const panOriginRef = useRef<SurfacePanOrigin | null>(null)

  const layoutSize = getZoomedSurfaceLayoutSize({
    contentDimensions: diagramSize,
    surfaceSize,
    zoom,
    padding: MERMAID_CANVAS_PADDING
  })
  const layoutStyle = getSurfaceLayoutStyle(layoutSize)

  const applyZoomChange = useCallback<ApplySurfaceZoomChange>((getNextZoom, anchor) => {
    applyAnchoredSurfaceZoomChange(localSurfaceRef.current, setZoom, getNextZoom, anchor)
  }, [])
  const handleSurfaceWheel = useCallback(
    (event: WheelEvent) => {
      applySurfaceWheel(event, applyZoomChange)
    },
    [applyZoomChange]
  )
  const setSurfaceRef = useCallback(
    (surface: HTMLDivElement | null) => {
      if (localSurfaceRef.current) {
        localSurfaceRef.current.removeEventListener('wheel', handleSurfaceWheel)
      }
      localSurfaceRef.current = surface
      if (surfaceRef) {
        surfaceRef.current = surface
      }
      if (surface) {
        setSurfaceSize(getElementSurfaceSize(surface))
        // Why: Chromium exposes trackpad pinch as ctrl-wheel and requires a
        // native non-passive listener to stop browser/app zoom.
        surface.addEventListener('wheel', handleSurfaceWheel, { passive: false })
      } else {
        setSurfaceSize(null)
      }
    },
    [handleSurfaceWheel, surfaceRef]
  )

  useEffect(() => {
    const surface = localSurfaceRef.current
    if (!surface || typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => setSurfaceSize(getElementSurfaceSize(surface)))
    observer.observe(surface)
    return () => observer.disconnect()
  }, [])

  const endPan = useCallback((pointerId: number): boolean => {
    if (panOriginRef.current?.pointerId !== pointerId) {
      return false
    }
    panOriginRef.current = null
    return true
  }, [])
  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const surface = localSurfaceRef.current
    if (!surface || panOriginRef.current || !shouldStartSurfacePan(event)) {
      return
    }
    const canPan =
      surface.scrollWidth > surface.clientWidth || surface.scrollHeight > surface.clientHeight
    if (!canPan) {
      return
    }

    panOriginRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      scrollLeft: surface.scrollLeft,
      scrollTop: surface.scrollTop
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])
  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const origin = panOriginRef.current
    const surface = localSurfaceRef.current
    if (!origin || !surface || origin.pointerId !== event.pointerId) {
      return
    }

    const { scrollLeft, scrollTop } = getPannedScrollOffsets(origin, event.clientX, event.clientY)
    surface.scrollLeft = scrollLeft
    surface.scrollTop = scrollTop
  }, [])
  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (endPan(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    },
    [endPan]
  )
  const handlePointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      endPan(event.pointerId)
    },
    [endPan]
  )

  const zoomPercent = Math.round(zoom * 100)
  const hasDiagram = diagramSize !== null
  const isPannable = zoom > 1

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div
        ref={setSurfaceRef}
        className={cn(
          'mermaid-viewer min-h-0 flex-1 overflow-auto scrollbar-editor',
          isPannable && 'cursor-grab select-none active:cursor-grabbing'
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handlePointerCancel}
      >
        <div className="mermaid-viewer-canvas">
          <div
            className="mermaid-diagram-box"
            data-zoom-layout={layoutSize ? 'true' : 'false'}
            style={layoutStyle}
          >
            {/* Why: DOMPurify's SVG profile strips <foreignObject> elements that
               mermaid uses for HTML labels. Force SVG-native <text> labels so
               they survive sanitization — same fix as the markdown preview path. */}
            <MermaidBlock
              content={content}
              isDark={isDark}
              htmlLabels={false}
              onRendered={setDiagramSize}
            />
          </div>
        </div>
      </div>
      {hasDiagram && (
        <div className="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5 shadow-xs">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate('editor.mermaidDiagram.zoomOut', 'Zoom out')}
            disabled={zoom <= MIN_SURFACE_ZOOM}
            onClick={() => applyZoomChange((currentZoom) => currentZoom / SURFACE_ZOOM_STEP)}
          >
            <ZoomOut className="size-3" />
          </Button>
          <span className="min-w-12 text-center text-[10px] text-muted-foreground tabular-nums">
            {zoomPercent}%
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate('editor.mermaidDiagram.zoomIn', 'Zoom in')}
            disabled={zoom >= MAX_SURFACE_ZOOM}
            onClick={() => applyZoomChange((currentZoom) => currentZoom * SURFACE_ZOOM_STEP)}
          >
            <ZoomIn className="size-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate('editor.mermaidDiagram.resetZoom', 'Fit diagram')}
            disabled={zoom === 1}
            onClick={() => applyZoomChange(() => 1)}
          >
            <RotateCcw className="size-3" />
          </Button>
        </div>
      )}
    </div>
  )
}
