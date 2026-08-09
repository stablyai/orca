import { Download } from 'lucide-react'
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { flushSync } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import {
  MAX_ROOM_IMAGE_ZOOM_PERCENT,
  ROOM_IMAGE_ZOOM_PRESETS,
  type RoomImagePoint,
  clampRoomImageAnchor,
  getRoomImageWheelZoomFactor,
  readRoomImageTouchGesture,
  roomImagePointInside
} from './room-image-preview-zoom'
import { RoomImagePreviewZoomMenu } from './RoomImagePreviewZoomMenu'

export type RoomImagePreview = {
  fileName: string
  src: string
  onDownload: () => void
}

export function RoomImagePreviewDialog({
  preview,
  onOpenChange
}: {
  preview: RoomImagePreview | null
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Dialog open={preview !== null} onOpenChange={onOpenChange}>
      {preview ? <RoomImagePreviewContent key={preview.src} preview={preview} /> : null}
    </Dialog>
  )
}

function RoomImagePreviewContent({ preview }: { preview: RoomImagePreview }): React.JSX.Element {
  const surfaceRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const touchPointsRef = useRef(new Map<number, RoomImagePoint>())
  const pinchRef = useRef<{ distance: number; zoomPercent: number } | null>(null)
  const panRef = useRef<
    (RoomImagePoint & { pointerId: number; scrollLeft: number; scrollTop: number }) | null
  >(null)
  const lastPointerRef = useRef<RoomImagePoint | null>(null)
  const zoomPercentRef = useRef(100)
  const minimumZoomPercentRef = useRef(ROOM_IMAGE_ZOOM_PRESETS[0])
  const [explicitZoomPercent, setExplicitZoomPercent] = useState<number | null>(null)
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null)
  const [surfaceSize, setSurfaceSize] = useState<{ width: number; height: number } | null>(null)
  const [surfaceNode, setSurfaceNode] = useState<HTMLDivElement | null>(null)
  const [isMouseDragging, setIsMouseDragging] = useState(false)

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
        () => {
          if (imageRef.current === image && image.isConnected) {
            readNaturalSize(image)
          }
        },
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
  const minimumZoomPercent = Math.min(
    ROOM_IMAGE_ZOOM_PRESETS[0],
    fitZoomPercent ?? ROOM_IMAGE_ZOOM_PRESETS[0]
  )
  const canPan =
    naturalSize !== null &&
    surfaceSize !== null &&
    (naturalSize.width * (zoomPercent / 100) > surfaceSize.width ||
      naturalSize.height * (zoomPercent / 100) > surfaceSize.height)
  zoomPercentRef.current = zoomPercent
  minimumZoomPercentRef.current = minimumZoomPercent

  const applyZoomAtPoint = useCallback((requestedZoomPercent: number, point: RoomImagePoint) => {
    const nextZoomPercent = Math.min(
      MAX_ROOM_IMAGE_ZOOM_PERCENT,
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
    const anchorX =
      before.width > 0 ? clampRoomImageAnchor((point.clientX - before.left) / before.width) : 0.5
    const anchorY =
      before.height > 0 ? clampRoomImageAnchor((point.clientY - before.top) / before.height) : 0.5
    flushSync(() => setExplicitZoomPercent(nextZoomPercent))
    const after = image.getBoundingClientRect()
    surface.scrollLeft += after.left + after.width * anchorX - point.clientX
    surface.scrollTop += after.top + after.height * anchorY - point.clientY
  }, [])

  const applyCenteredZoom = (nextZoomPercent: number): void => {
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
  }

  const resetToFit = (): void => {
    setExplicitZoomPercent(null)
    if (surfaceRef.current) {
      surfaceRef.current.scrollLeft = 0
      surfaceRef.current.scrollTop = 0
    }
  }

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
      const point = roomImagePointInside(eventPoint, rect)
        ? eventPoint
        : lastPointerRef.current && roomImagePointInside(lastPointerRef.current, rect)
          ? lastPointerRef.current
          : { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
      applyZoomAtPoint(
        zoomPercentRef.current * getRoomImageWheelZoomFactor(event.deltaY, event.deltaMode),
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
    const gesture = readRoomImageTouchGesture(touchPointsRef.current)
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
      const gesture = readRoomImageTouchGesture(touchPointsRef.current)
      if (!initial || !gesture) {
        return
      }
      applyZoomAtPoint(initial.zoomPercent * (gesture.distance / initial.distance), gesture)
      return
    }

    const pan = panRef.current
    if (!pan || pan.pointerId !== event.pointerId) {
      return
    }
    event.preventDefault()
    event.currentTarget.scrollLeft = pan.scrollLeft - (event.clientX - pan.clientX)
    event.currentTarget.scrollTop = pan.scrollTop - (event.clientY - pan.clientY)
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
      | [number, RoomImagePoint]
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
    const gesture = readRoomImageTouchGesture(touchPointsRef.current)
    pinchRef.current = gesture
      ? { distance: gesture.distance, zoomPercent: zoomPercentRef.current }
      : null
  }

  const roundedZoomPercent = Math.round(zoomPercent)
  return (
    <DialogContent className="flex h-[80vh] w-[80vw] max-w-[80vw] flex-col gap-0 overflow-hidden p-0">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 pr-12">
        <DialogTitle className="min-w-0 flex-1 truncate text-sm">{preview.fileName}</DialogTitle>
        <RoomImagePreviewZoomMenu
          zoomPercent={roundedZoomPercent}
          fitSelected={explicitZoomPercent === null}
          onSelect={applyCenteredZoom}
          onFit={resetToFit}
        />
        <Button variant="outline" size="xs" onClick={preview.onDownload}>
          <Download className="size-3.5" />
          {translate('rooms.attachment.download', 'Download')}
        </Button>
      </div>
      <div
        ref={setSurfaceElement}
        data-testid="room-image-preview-surface"
        className="flex min-h-0 flex-1 touch-none items-start justify-start overflow-auto bg-muted/20 scrollbar-editor"
        onPointerCancelCapture={handlePointerEnd}
        onPointerDownCapture={handlePointerDown}
        onPointerMoveCapture={handlePointerMove}
        onPointerUpCapture={handlePointerEnd}
      >
        <img
          ref={setImageNode}
          src={preview.src}
          alt={preview.fileName}
          className={`m-auto object-contain ${
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
