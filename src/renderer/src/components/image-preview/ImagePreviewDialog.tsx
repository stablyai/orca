import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { flushSync } from 'react-dom'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  IMAGE_ZOOM_LEVELS,
  MAX_IMAGE_ZOOM_PERCENT,
  type ImagePoint,
  clampImageAnchor,
  getImageWheelZoomFactor,
  imagePointInside,
  readImageTouchGesture
} from './image-preview-zoom'
import { ImagePreviewControls, type ImagePreview } from './ImagePreviewControls'

export type { ImagePreview } from './ImagePreviewControls'

export function ImagePreviewDialog({
  preview,
  onOpenChange
}: {
  preview: ImagePreview | null
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Dialog open={preview !== null} onOpenChange={onOpenChange}>
      {preview ? (
        <ImagePreviewContent preview={preview} onClose={() => onOpenChange(false)} />
      ) : null}
    </Dialog>
  )
}

function ImagePreviewContent({
  preview,
  onClose
}: {
  preview: ImagePreview
  onClose: () => void
}): React.JSX.Element {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const touchPointsRef = useRef(new Map<number, ImagePoint>())
  const pinchRef = useRef<{ distance: number; zoomPercent: number } | null>(null)
  const panRef = useRef<
    (ImagePoint & { pointerId: number; scrollLeft: number; scrollTop: number }) | null
  >(null)
  const lastPointerRef = useRef<ImagePoint | null>(null)
  const zoomPercentRef = useRef(100)
  const minimumZoomPercentRef = useRef(IMAGE_ZOOM_LEVELS[0])
  const [explicitZoomPercent, setExplicitZoomPercent] = useState<number | null>(null)
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null)
  const [surfaceSize, setSurfaceSize] = useState<{ width: number; height: number } | null>(null)
  const [surfaceNode, setSurfaceNode] = useState<HTMLDivElement | null>(null)
  const [isMouseDragging, setIsMouseDragging] = useState(false)

  useLayoutEffect(() => {
    setExplicitZoomPercent(null)
    setNaturalSize(null)
    const surface = surfaceRef.current
    if (surface) {
      surface.scrollLeft = surface.scrollTop = 0
    }
  }, [preview.src])

  const setSurfaceElement = useCallback((surface: HTMLDivElement | null): void => {
    surfaceRef.current = surface
    setSurfaceNode(surface)
  }, [])

  const readNaturalSize = useCallback((image: HTMLImageElement): void => {
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight })
    }
  }, [])
  const setImageNode = useCallback(
    (image: HTMLImageElement | null): void => {
      imageRef.current = image
      if (!image) {
        return
      }
      readNaturalSize(image)
      void image.decode?.().then(
        () => imageRef.current === image && image.isConnected && readNaturalSize(image),
        () => undefined
      )
    },
    [readNaturalSize]
  )

  const fitZoomPercent = useMemo(() => {
    if (!naturalSize || !surfaceSize) {
      return null
    }
    const scale = Math.min(
      1,
      surfaceSize.width / naturalSize.width,
      surfaceSize.height / naturalSize.height
    )
    return Number.isFinite(scale) && scale > 0 ? scale * 100 : null
  }, [naturalSize, surfaceSize])
  const zoomPercent = explicitZoomPercent ?? fitZoomPercent ?? 100
  const minimumZoomPercent = Math.min(IMAGE_ZOOM_LEVELS[0], fitZoomPercent ?? IMAGE_ZOOM_LEVELS[0])
  const zoomLevels = useMemo(
    () =>
      Array.from(new Set([...IMAGE_ZOOM_LEVELS, ...(fitZoomPercent ? [fitZoomPercent] : [])])).sort(
        (left, right) => left - right
      ),
    [fitZoomPercent]
  )
  const canPan =
    naturalSize !== null &&
    surfaceSize !== null &&
    (naturalSize.width * (zoomPercent / 100) > surfaceSize.width ||
      naturalSize.height * (zoomPercent / 100) > surfaceSize.height)
  zoomPercentRef.current = zoomPercent
  minimumZoomPercentRef.current = minimumZoomPercent

  const applyZoomAtPoint = useCallback((requestedZoomPercent: number, point: ImagePoint) => {
    const nextZoomPercent = Math.min(
      MAX_IMAGE_ZOOM_PERCENT,
      Math.max(minimumZoomPercentRef.current, requestedZoomPercent)
    )
    const currentZoomPercent = zoomPercentRef.current
    if (nextZoomPercent === currentZoomPercent) {
      return
    }
    const surface = surfaceRef.current
    const image = imageRef.current
    if (!surface || !image) {
      setExplicitZoomPercent(nextZoomPercent)
      return
    }
    const before = image.getBoundingClientRect()
    const anchorX = before.width
      ? clampImageAnchor((point.clientX - before.left) / before.width)
      : 0.5
    const anchorY = before.height
      ? clampImageAnchor((point.clientY - before.top) / before.height)
      : 0.5
    flushSync(() => setExplicitZoomPercent(nextZoomPercent))
    const after = image.getBoundingClientRect()
    surface.scrollLeft += after.left + after.width * anchorX - point.clientX
    surface.scrollTop += after.top + after.height * anchorY - point.clientY
  }, [])

  const applyCenteredZoom = useCallback(
    (nextZoomPercent: number): void => {
      const surface = surfaceRef.current
      if (!surface) {
        setExplicitZoomPercent(nextZoomPercent)
        return
      }
      const rect = surface.getBoundingClientRect()
      applyZoomAtPoint(nextZoomPercent, {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      })
    },
    [applyZoomAtPoint]
  )

  const resetToFit = useCallback((): void => {
    setExplicitZoomPercent(null)
    if (surfaceRef.current) {
      surfaceRef.current.scrollLeft = 0
      surfaceRef.current.scrollTop = 0
    }
  }, [])

  const adjacentZoom = useCallback(
    (direction: -1 | 1): void => {
      const current = zoomPercentRef.current
      const next =
        direction > 0
          ? zoomLevels.find((level) => level > current + 0.01)
          : zoomLevels.findLast((level) => level < current - 0.01)
      if (next !== undefined) {
        applyCenteredZoom(next)
      }
    },
    [applyCenteredZoom, zoomLevels]
  )

  useEffect(() => {
    const surface = surfaceNode
    if (!surface) {
      return
    }
    const updateSize = (): void =>
      setSurfaceSize({ width: surface.clientWidth, height: surface.clientHeight })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateSize)
    const handleWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const rect = surface.getBoundingClientRect()
      const eventPoint = { clientX: event.clientX, clientY: event.clientY }
      const point = imagePointInside(eventPoint, rect)
        ? eventPoint
        : lastPointerRef.current && imagePointInside(lastPointerRef.current, rect)
          ? lastPointerRef.current
          : { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
      applyZoomAtPoint(
        zoomPercentRef.current * getImageWheelZoomFactor(event.deltaY, event.deltaMode),
        point
      )
    }
    updateSize()
    observer?.observe(surface)
    surface.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      observer?.disconnect()
      surface.removeEventListener('wheel', handleWheel)
    }
  }, [applyZoomAtPoint, surfaceNode])

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    lastPointerRef.current = { clientX: event.clientX, clientY: event.clientY }
    if (event.pointerType !== 'touch') {
      if (event.button !== 0 || !canPan || event.target !== imageRef.current) {
        return
      }
      event.preventDefault()
      event.currentTarget.setPointerCapture?.(event.pointerId)
      panRef.current = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        scrollLeft: event.currentTarget.scrollLeft,
        scrollTop: event.currentTarget.scrollTop
      }
      setIsMouseDragging(true)
      return
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    touchPointsRef.current.set(event.pointerId, {
      clientX: event.clientX,
      clientY: event.clientY
    })
    if (touchPointsRef.current.size === 1) {
      panRef.current = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        scrollLeft: event.currentTarget.scrollLeft,
        scrollTop: event.currentTarget.scrollTop
      }
      return
    }
    panRef.current = null
    const gesture = readImageTouchGesture(touchPointsRef.current)
    pinchRef.current = gesture
      ? { distance: gesture.distance, zoomPercent: zoomPercentRef.current }
      : null
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    lastPointerRef.current = { clientX: event.clientX, clientY: event.clientY }
    if (event.pointerType !== 'touch') {
      const pan = panRef.current
      if (!pan || pan.pointerId !== event.pointerId) {
        return
      }
      event.preventDefault()
      event.currentTarget.scrollLeft = pan.scrollLeft - (event.clientX - pan.clientX)
      event.currentTarget.scrollTop = pan.scrollTop - (event.clientY - pan.clientY)
      return
    }
    if (!touchPointsRef.current.has(event.pointerId)) {
      return
    }
    touchPointsRef.current.set(event.pointerId, {
      clientX: event.clientX,
      clientY: event.clientY
    })
    if (touchPointsRef.current.size > 1) {
      event.preventDefault()
      event.stopPropagation()
      panRef.current = null
      const initial = pinchRef.current
      const gesture = readImageTouchGesture(touchPointsRef.current)
      if (initial && gesture) {
        applyZoomAtPoint(initial.zoomPercent * (gesture.distance / initial.distance), gesture)
      }
      return
    }
    const pan = panRef.current
    if (pan?.pointerId === event.pointerId) {
      event.preventDefault()
      event.currentTarget.scrollLeft = pan.scrollLeft - (event.clientX - pan.clientX)
      event.currentTarget.scrollTop = pan.scrollTop - (event.clientY - pan.clientY)
    }
  }

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType !== 'touch') {
      if (panRef.current?.pointerId === event.pointerId) {
        panRef.current = null
        setIsMouseDragging(false)
      }
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture?.(event.pointerId)
      }
      return
    }
    touchPointsRef.current.delete(event.pointerId)
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    }
    const remaining = touchPointsRef.current.entries().next().value as
      | [number, ImagePoint]
      | undefined
    if (!remaining) {
      panRef.current = null
      pinchRef.current = null
      return
    }
    if (touchPointsRef.current.size === 1) {
      const [pointerId, point] = remaining
      panRef.current = {
        pointerId,
        ...point,
        scrollLeft: event.currentTarget.scrollLeft,
        scrollTop: event.currentTarget.scrollTop
      }
      pinchRef.current = null
      return
    }
    const gesture = readImageTouchGesture(touchPointsRef.current)
    pinchRef.current = gesture
      ? { distance: gesture.distance, zoomPercent: zoomPercentRef.current }
      : null
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const modifier = navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey
    if (modifier && (event.key === '+' || event.key === '=')) {
      event.preventDefault()
      adjacentZoom(1)
    } else if (modifier && event.key === '-') {
      event.preventDefault()
      adjacentZoom(-1)
    } else if (modifier && event.key === '0') {
      event.preventDefault()
      resetToFit()
    } else if (!modifier && event.key === 'ArrowLeft' && preview.onPrevious) {
      event.preventDefault()
      preview.onPrevious()
    } else if (!modifier && event.key === 'ArrowRight' && preview.onNext) {
      event.preventDefault()
      preview.onNext()
    }
  }

  const canZoomOut = zoomLevels.some((level) => level < zoomPercent - 0.01)
  const canZoomIn = zoomLevels.some((level) => level > zoomPercent + 0.01)
  return (
    <DialogContent
      showCloseButton={false}
      overlayClassName="bg-black/90 backdrop-blur-none"
      className="inset-0 top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 overflow-hidden rounded-none border-0 bg-transparent p-0 shadow-none backdrop-blur-none sm:max-w-none"
      onKeyDown={handleKeyDown}
    >
      <DialogTitle className="sr-only">{preview.fileName}</DialogTitle>
      <ImagePreviewControls
        preview={preview}
        zoomPercent={Math.round(zoomPercent)}
        canZoomOut={canZoomOut}
        canZoomIn={canZoomIn}
        onZoomOut={() => adjacentZoom(-1)}
        onZoomIn={() => adjacentZoom(1)}
        onReset={resetToFit}
      />
      <div
        ref={setSurfaceElement}
        data-testid="image-preview-surface"
        className="flex size-full touch-none items-start justify-start overflow-auto scrollbar-editor"
        onClick={(event) => event.target === event.currentTarget && onClose()}
        onPointerCancelCapture={handlePointerEnd}
        onPointerDownCapture={handlePointerDown}
        onPointerMoveCapture={handlePointerMove}
        onPointerUpCapture={handlePointerEnd}
      >
        <img
          ref={setImageNode}
          src={preview.src}
          alt={preview.fileName}
          className={`m-auto rounded-lg object-contain ${
            naturalSize ? 'block max-w-none' : 'max-h-full max-w-full'
          } ${isMouseDragging ? 'cursor-grabbing' : canPan ? 'cursor-grab' : ''}`}
          style={
            naturalSize
              ? {
                  width: `${naturalSize.width * (zoomPercent / 100)}px`,
                  height: `${naturalSize.height * (zoomPercent / 100)}px`
                }
              : undefined
          }
          draggable={false}
          onLoad={(event) => readNaturalSize(event.currentTarget)}
        />
      </div>
    </DialogContent>
  )
}
