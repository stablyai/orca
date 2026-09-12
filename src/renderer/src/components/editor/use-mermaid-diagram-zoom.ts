import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type ApplyImageViewerZoomChange,
  applyAnchoredImageViewerZoomChange,
  applyImageSurfaceWheel,
  getElementSurfaceSize,
  getImageLayoutStyle
} from './image-viewer-dom-zoom'
import {
  IMAGE_VIEWER_ZOOM_STEP,
  MAX_IMAGE_VIEWER_ZOOM,
  MIN_IMAGE_VIEWER_ZOOM,
  type ImageViewerImageDimensions,
  type ImageViewerSurfaceSize,
  getZoomedImageLayoutSize
} from './image-viewer-zoom'

export function useMermaidDiagramZoom(): {
  zoomPercent: number
  layoutStyle: ReturnType<typeof getImageLayoutStyle>
  canZoomIn: boolean
  canZoomOut: boolean
  canReset: boolean
  setSurfaceNode: (surface: HTMLDivElement | null) => void
  setDiagramSize: (size: ImageViewerImageDimensions | null) => void
  zoomIn: () => void
  zoomOut: () => void
  resetZoom: () => void
} {
  const [zoom, setZoom] = useState(1)
  const [surfaceEl, setSurfaceEl] = useState<HTMLDivElement | null>(null)
  const [surfaceSize, setSurfaceSize] = useState<ImageViewerSurfaceSize | null>(null)
  const [diagramSize, setDiagramSize] = useState<ImageViewerImageDimensions | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)

  const applyZoomChange = useCallback<ApplyImageViewerZoomChange>((getNextZoom, anchor) => {
    applyAnchoredImageViewerZoomChange(surfaceRef.current, setZoom, getNextZoom, anchor)
  }, [])

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      applyImageSurfaceWheel(event, applyZoomChange)
    },
    [applyZoomChange]
  )

  const setSurfaceNode = useCallback((surface: HTMLDivElement | null) => {
    surfaceRef.current = surface
    setSurfaceEl(surface)
    setSurfaceSize(surface ? getElementSurfaceSize(surface) : null)
  }, [])

  useEffect(() => {
    if (!surfaceEl) {
      return
    }

    const updateSize = (): void => setSurfaceSize(getElementSurfaceSize(surfaceEl))
    updateSize()
    surfaceEl.addEventListener('wheel', handleWheel, { passive: false })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateSize)
    observer?.observe(surfaceEl)
    return () => {
      surfaceEl.removeEventListener('wheel', handleWheel)
      observer?.disconnect()
    }
  }, [handleWheel, surfaceEl])

  const zoomIn = useCallback(() => {
    applyZoomChange((currentZoom) => currentZoom * IMAGE_VIEWER_ZOOM_STEP)
  }, [applyZoomChange])
  const zoomOut = useCallback(() => {
    applyZoomChange((currentZoom) => currentZoom / IMAGE_VIEWER_ZOOM_STEP)
  }, [applyZoomChange])
  const resetZoom = useCallback(() => {
    applyZoomChange(() => 1)
  }, [applyZoomChange])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        zoomIn()
        return
      }
      if (event.key === '-') {
        event.preventDefault()
        zoomOut()
        return
      }
      if (event.key === '0') {
        event.preventDefault()
        resetZoom()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [resetZoom, zoomIn, zoomOut])

  const layoutSize = useMemo(
    () =>
      getZoomedImageLayoutSize({
        imageDimensions: diagramSize,
        surfaceSize,
        zoom
      }),
    [diagramSize, surfaceSize, zoom]
  )

  return {
    zoomPercent: Math.round(zoom * 100),
    layoutStyle: getImageLayoutStyle(layoutSize),
    canZoomIn: zoom < MAX_IMAGE_VIEWER_ZOOM,
    canZoomOut: zoom > MIN_IMAGE_VIEWER_ZOOM,
    canReset: zoom !== 1,
    setSurfaceNode,
    setDiagramSize,
    zoomIn,
    zoomOut,
    resetZoom
  }
}
