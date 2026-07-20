import {
  type ImageViewerPanPoint,
  type ImageViewerPanTrigger,
  getImageViewerPanScrollPosition,
  hasImageViewerPanCrossedThreshold
} from './image-viewer-pan'

type ImageViewerPanWindow = Pick<Window, 'addEventListener' | 'removeEventListener'>

export type ImageViewerPanEndReason =
  | 'pointerup'
  | 'pointercancel'
  | 'lostpointercapture'
  | 'blur'
  | 'manual'

export type ImageViewerPanEnd = {
  didDrag: boolean
  reason: ImageViewerPanEndReason
  trigger: ImageViewerPanTrigger
}

export type ImageViewerPanCleanup = (reason?: ImageViewerPanEndReason) => void

export function beginImageViewerPan({
  surface,
  pointerId,
  trigger,
  startPointer,
  onDraggingChange,
  onEnd,
  ownerWindow = window
}: {
  surface: HTMLDivElement
  pointerId: number
  trigger: ImageViewerPanTrigger
  startPointer: ImageViewerPanPoint
  onDraggingChange: (dragging: boolean) => void
  onEnd: (end: ImageViewerPanEnd) => void
  ownerWindow?: ImageViewerPanWindow
}): ImageViewerPanCleanup {
  const startScroll = { x: surface.scrollLeft, y: surface.scrollTop }
  let didDrag = false
  let cleaned = false

  const cleanup: ImageViewerPanCleanup = (reason = 'manual') => {
    if (cleaned) {
      return
    }
    cleaned = true
    try {
      if (surface.hasPointerCapture(pointerId)) {
        surface.releasePointerCapture(pointerId)
      }
    } catch {
      // 元素可能已卸载，清理仍需继续移除窗口监听器。
    }
    ownerWindow.removeEventListener('pointermove', handlePointerMove)
    ownerWindow.removeEventListener('pointerup', handlePointerUp)
    ownerWindow.removeEventListener('pointercancel', handlePointerCancel)
    ownerWindow.removeEventListener('blur', handleWindowBlur)
    surface.removeEventListener('lostpointercapture', handleLostPointerCapture)
    onDraggingChange(false)
    onEnd({ didDrag, reason, trigger })
  }

  const handlePointerMove = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    if (pointerEvent.pointerId !== pointerId) {
      return
    }
    const currentPointer = { x: pointerEvent.clientX, y: pointerEvent.clientY }
    if (!didDrag) {
      if (!hasImageViewerPanCrossedThreshold(startPointer, currentPointer)) {
        return
      }
      didDrag = true
    }
    pointerEvent.preventDefault()
    const nextScroll = getImageViewerPanScrollPosition({
      startScroll,
      startPointer,
      currentPointer
    })
    surface.scrollLeft = nextScroll.x
    surface.scrollTop = nextScroll.y
  }

  const handlePointerUp = (event: Event): void => {
    if ((event as PointerEvent).pointerId === pointerId) {
      cleanup('pointerup')
    }
  }

  const handlePointerCancel = (event: Event): void => {
    if ((event as PointerEvent).pointerId === pointerId) {
      cleanup('pointercancel')
    }
  }

  const handleLostPointerCapture = (event: Event): void => {
    if ((event as PointerEvent).pointerId === pointerId) {
      cleanup('lostpointercapture')
    }
  }

  const handleWindowBlur = (): void => cleanup('blur')

  onDraggingChange(true)
  try {
    surface.setPointerCapture(pointerId)
  } catch {
    // 捕获失败时窗口监听器仍能完成拖动和清理。
  }
  ownerWindow.addEventListener('pointermove', handlePointerMove)
  ownerWindow.addEventListener('pointerup', handlePointerUp)
  ownerWindow.addEventListener('pointercancel', handlePointerCancel)
  ownerWindow.addEventListener('blur', handleWindowBlur)
  surface.addEventListener('lostpointercapture', handleLostPointerCapture)

  return cleanup
}
