import { RotateCcw, ZoomIn, ZoomOut } from 'lucide-react'
import React, {
  type CSSProperties,
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { Button } from '@/components/ui/button'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  type ApplySurfaceZoomChange,
  applyAnchoredSurfaceZoomChange,
  applySurfaceWheel,
  getElementSurfaceSize,
  getSurfaceLayoutStyle
} from './anchored-surface-dom-zoom'
import {
  DIAGRAM_SURFACE_ZOOM_BOUNDS,
  DIAGRAM_SURFACE_ZOOM_STEP,
  MAX_DIAGRAM_SURFACE_ZOOM,
  MIN_DIAGRAM_SURFACE_ZOOM,
  type DiagramSurfacePanStart,
  type DiagramSurfaceDimensions,
  getDiagramSurfaceKeyboardZoomIntent,
  getDraggedDiagramSurfaceScrollPosition,
  getZoomedDiagramLayoutSize
} from './diagram-surface-zoom'

type ZoomableDiagramSurfaceProps = {
  children: React.ReactNode
  className?: string
  contentClassName?: string
  diagramKey: string
  label?: string
  resetKey?: string
}

function parseSvgLength(value: string | null): number | null {
  if (!value) {
    return null
  }

  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function getSvgIntrinsicSize(svg: SVGSVGElement | null): DiagramSurfaceDimensions | null {
  if (!svg) {
    return null
  }

  const viewBox = svg.viewBox?.baseVal
  if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
    return { width: viewBox.width, height: viewBox.height }
  }

  const width = parseSvgLength(svg.getAttribute('width'))
  const height = parseSvgLength(svg.getAttribute('height'))
  if (width !== null && height !== null) {
    return { width, height }
  }

  const rect = svg.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : null
}

function dimensionsEqual(
  current: DiagramSurfaceDimensions | null,
  next: DiagramSurfaceDimensions | null
): boolean {
  return current?.width === next?.width && current?.height === next?.height
}

export default function ZoomableDiagramSurface({
  children,
  className,
  contentClassName,
  diagramKey,
  label,
  resetKey
}: ZoomableDiagramSurfaceProps): JSX.Element {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const panDragRef = useRef<
    (DiagramSurfacePanStart & { didMove: boolean; pointerId: number }) | null
  >(null)
  const [zoom, setZoom] = useState(1)
  const [isPanReady, setIsPanReady] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [surfaceElement, setSurfaceElement] = useState<HTMLDivElement | null>(null)
  const [surfaceSize, setSurfaceSize] = useState<DiagramSurfaceDimensions | null>(null)
  const [diagramSize, setDiagramSize] = useState<DiagramSurfaceDimensions | null>(null)
  const shortcutPlatform = useMemo(() => getShortcutPlatform(), [])

  const zoomPercent = Math.round(zoom * 100)
  const layoutSize = useMemo(
    () => getZoomedDiagramLayoutSize({ diagramDimensions: diagramSize, surfaceSize, zoom }),
    [diagramSize, surfaceSize, zoom]
  )
  const layoutStyle = useMemo<CSSProperties | undefined>(
    () => getSurfaceLayoutStyle(layoutSize),
    [layoutSize]
  )
  const zoomOutLabel = translate(
    'auto.components.editor.ZoomableDiagramSurface.zoomOut',
    'Zoom out'
  )
  const resetZoomLabel = translate(
    'auto.components.editor.ZoomableDiagramSurface.resetZoom',
    'Reset zoom'
  )
  const zoomInLabel = translate('auto.components.editor.ZoomableDiagramSurface.zoomIn', 'Zoom in')
  const viewportLabel = translate(
    'auto.components.editor.ZoomableDiagramSurface.viewport',
    'Diagram canvas'
  )

  const applyZoomChange = useCallback<ApplySurfaceZoomChange>((getNextZoom, anchor) => {
    applyAnchoredSurfaceZoomChange(
      surfaceRef.current,
      setZoom,
      getNextZoom,
      DIAGRAM_SURFACE_ZOOM_BOUNDS,
      anchor
    )
  }, [])

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      applySurfaceWheel(event, applyZoomChange, DIAGRAM_SURFACE_ZOOM_BOUNDS)
    },
    [applyZoomChange]
  )

  const setSurfaceRef = useCallback((surface: HTMLDivElement | null) => {
    surfaceRef.current = surface
    setSurfaceElement(surface)
    if (surface) {
      const nextSize = getElementSurfaceSize(surface)
      setSurfaceSize((currentSize) =>
        dimensionsEqual(currentSize, nextSize) ? currentSize : nextSize
      )
    } else {
      setSurfaceSize(null)
    }
  }, [])

  const updateDiagramSize = useCallback(() => {
    const svg = contentRef.current?.querySelector('svg') ?? null
    const nextSize = getSvgIntrinsicSize(svg)
    setDiagramSize((currentSize) =>
      dimensionsEqual(currentSize, nextSize) ? currentSize : nextSize
    )
  }, [])

  useEffect(() => {
    setZoom(1)
  }, [resetKey])

  useEffect(() => {
    if (!surfaceElement) {
      setSurfaceSize(null)
      return
    }

    const updateSize = () => {
      const nextSize = getElementSurfaceSize(surfaceElement)
      setSurfaceSize((currentSize) =>
        dimensionsEqual(currentSize, nextSize) ? currentSize : nextSize
      )
    }
    updateSize()
    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(updateSize)
    observer.observe(surfaceElement)
    return () => observer.disconnect()
  }, [surfaceElement])

  useEffect(() => {
    if (!surfaceElement) {
      return
    }

    surfaceElement.addEventListener('wheel', handleWheel, { passive: false })
    return () => surfaceElement.removeEventListener('wheel', handleWheel)
  }, [handleWheel, surfaceElement])

  useEffect(() => {
    const content = contentRef.current
    if (!content) {
      setDiagramSize(null)
      return
    }

    updateDiagramSize()
    let mutationObserver: MutationObserver | null = null
    if (typeof MutationObserver !== 'undefined') {
      mutationObserver = new MutationObserver(updateDiagramSize)
      mutationObserver.observe(content, { childList: true, subtree: true, attributes: true })
    }

    return () => {
      mutationObserver?.disconnect()
    }
  }, [diagramKey, updateDiagramSize])

  const finishPanDrag = useCallback((pointerId: number) => {
    const surface = surfaceRef.current
    if (surface?.hasPointerCapture?.(pointerId)) {
      surface.releasePointerCapture(pointerId)
    }
    panDragRef.current = null
    setIsPanning(false)
  }, [])

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) {
      return
    }

    const surface = surfaceRef.current
    if (!surface) {
      return
    }

    surface.focus({ preventScroll: true })
    panDragRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      didMove: false,
      pointerId: event.pointerId,
      scrollLeft: surface.scrollLeft,
      scrollTop: surface.scrollTop
    }
    surface.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }, [])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = panDragRef.current
    const surface = surfaceRef.current
    if (!drag || drag.pointerId !== event.pointerId || !surface) {
      return
    }

    const deltaX = event.clientX - drag.clientX
    const deltaY = event.clientY - drag.clientY
    if (!drag.didMove && Math.hypot(deltaX, deltaY) > 2) {
      drag.didMove = true
      setIsPanning(true)
    }

    const nextScroll = getDraggedDiagramSurfaceScrollPosition({
      start: drag,
      clientX: event.clientX,
      clientY: event.clientY
    })
    surface.scrollLeft = nextScroll.scrollLeft
    surface.scrollTop = nextScroll.scrollTop
    event.preventDefault()
  }, [])

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (panDragRef.current?.pointerId === event.pointerId) {
        finishPanDrag(event.pointerId)
      }
    },
    [finishPanDrag]
  )

  const handleViewportKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const zoomIntent = getDiagramSurfaceKeyboardZoomIntent(event, shortcutPlatform)
      if (zoomIntent) {
        event.preventDefault()
        event.stopPropagation()
        if (zoomIntent === 'zoom-in') {
          applyZoomChange((currentZoom) => currentZoom * DIAGRAM_SURFACE_ZOOM_STEP)
        } else if (zoomIntent === 'zoom-out') {
          applyZoomChange((currentZoom) => currentZoom / DIAGRAM_SURFACE_ZOOM_STEP)
        } else {
          applyZoomChange(() => 1)
        }
        return
      }

      if (
        (event.key === ' ' || event.code === 'Space') &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault()
        setIsPanReady(true)
      }
    },
    [applyZoomChange, shortcutPlatform]
  )

  const handleViewportKeyUp = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === ' ' || event.code === 'Space') {
      event.preventDefault()
      setIsPanReady(false)
    }
  }, [])

  useEffect(() => {
    const handleWindowKeyUp = (event: KeyboardEvent): void => {
      if (event.key === ' ' || event.code === 'Space') {
        setIsPanReady(false)
      }
    }
    const handleWindowBlur = (): void => {
      panDragRef.current = null
      setIsPanReady(false)
      setIsPanning(false)
    }

    window.addEventListener('keyup', handleWindowKeyUp)
    window.addEventListener('blur', handleWindowBlur)
    return () => {
      window.removeEventListener('keyup', handleWindowKeyUp)
      window.removeEventListener('blur', handleWindowBlur)
    }
  }, [])

  return (
    <div className={cn('zoomable-diagram-surface', className)}>
      <div
        ref={setSurfaceRef}
        className={cn(
          'zoomable-diagram-surface-viewport scrollbar-editor',
          isPanReady && 'is-pan-ready',
          isPanning && 'is-panning'
        )}
        tabIndex={0}
        aria-label={viewportLabel}
        onBlur={() => setIsPanReady(false)}
        onKeyDown={handleViewportKeyDown}
        onKeyUp={handleViewportKeyUp}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerCancel={handlePointerUp}
        onPointerUp={handlePointerUp}
        onLostPointerCapture={handlePointerUp}
      >
        <div className="zoomable-diagram-surface-stage">
          <div
            ref={contentRef}
            className={cn(
              'zoomable-diagram-surface-content',
              layoutSize && 'is-sized',
              contentClassName
            )}
            style={layoutStyle}
          >
            {children}
          </div>
        </div>
      </div>
      <div className="zoomable-diagram-surface-toolbar">
        <div className="zoomable-diagram-surface-controls">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() =>
              applyZoomChange((currentZoom) => currentZoom / DIAGRAM_SURFACE_ZOOM_STEP)
            }
            disabled={zoom <= MIN_DIAGRAM_SURFACE_ZOOM}
            aria-label={zoomOutLabel}
            title={zoomOutLabel}
          >
            <ZoomOut />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => applyZoomChange(() => 1)}
            disabled={zoom === 1}
            aria-label={resetZoomLabel}
            title={resetZoomLabel}
          >
            <RotateCcw />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() =>
              applyZoomChange((currentZoom) => currentZoom * DIAGRAM_SURFACE_ZOOM_STEP)
            }
            disabled={zoom >= MAX_DIAGRAM_SURFACE_ZOOM}
            aria-label={zoomInLabel}
            title={zoomInLabel}
          >
            <ZoomIn />
          </Button>
          <span className="zoomable-diagram-surface-zoom tabular-nums">{zoomPercent}%</span>
        </div>
        {label ? <div className="zoomable-diagram-surface-label">{label}</div> : null}
      </div>
    </div>
  )
}
