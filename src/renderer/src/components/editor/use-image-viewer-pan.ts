import {
  type MouseEventHandler,
  type PointerEventHandler,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'
import { type ImageViewerPanCleanup, beginImageViewerPan } from './image-viewer-dom-pan'
import { type ImageViewerPanTrigger, getImageViewerPanTrigger } from './image-viewer-pan'

export type ImageViewerPanSurfaceBindings = {
  cursorClassName: 'cursor-grab' | 'cursor-grabbing' | undefined
  onClickCapture: MouseEventHandler<HTMLDivElement>
  onPointerDown: PointerEventHandler<HTMLDivElement>
  onPointerEnter: PointerEventHandler<HTMLDivElement>
  onPointerLeave: PointerEventHandler<HTMLDivElement>
}

function isSpaceKey(event: KeyboardEvent): boolean {
  return event.code === 'Space'
}

export function useImageViewerPanSurface(): ImageViewerPanSurfaceBindings {
  const [isSpacePressed, setIsSpacePressed] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const isSpacePressedRef = useRef(false)
  const isPointerInsideRef = useRef(false)
  const activeTriggerRef = useRef<ImageViewerPanTrigger | null>(null)
  const activeCleanupRef = useRef<ImageViewerPanCleanup | null>(null)
  const suppressClickRef = useRef(false)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (
        !isSpaceKey(event) ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        !isPointerInsideRef.current
      ) {
        return
      }
      isSpacePressedRef.current = true
      setIsSpacePressed(true)
      event.preventDefault()
    }

    const handleKeyUp = (event: KeyboardEvent): void => {
      if (!isSpaceKey(event)) {
        return
      }
      isSpacePressedRef.current = false
      setIsSpacePressed(false)
      if (activeTriggerRef.current === 'space-left') {
        activeCleanupRef.current?.()
      }
    }

    const handleWindowBlur = (): void => {
      isSpacePressedRef.current = false
      setIsSpacePressed(false)
      activeCleanupRef.current?.('blur')
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleWindowBlur)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleWindowBlur)
      activeCleanupRef.current?.()
    }
  }, [])

  const onPointerDown = useCallback<PointerEventHandler<HTMLDivElement>>((event) => {
    activeCleanupRef.current?.()
    suppressClickRef.current = false
    const trigger = getImageViewerPanTrigger(event.button, isSpacePressedRef.current)
    if (!trigger) {
      return
    }

    event.preventDefault()
    activeTriggerRef.current = trigger
    activeCleanupRef.current = beginImageViewerPan({
      surface: event.currentTarget,
      pointerId: event.pointerId,
      trigger,
      startPointer: { x: event.clientX, y: event.clientY },
      onDraggingChange: setIsDragging,
      onEnd: ({ didDrag, trigger: endedTrigger }) => {
        activeCleanupRef.current = null
        activeTriggerRef.current = null
        if (didDrag && endedTrigger === 'space-left') {
          suppressClickRef.current = true
        }
      }
    })
  }, [])

  const onClickCapture = useCallback<MouseEventHandler<HTMLDivElement>>((event) => {
    if (!suppressClickRef.current) {
      return
    }
    suppressClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const onPointerEnter = useCallback(() => {
    isPointerInsideRef.current = true
  }, [])

  const onPointerLeave = useCallback(() => {
    isPointerInsideRef.current = false
  }, [])

  return {
    cursorClassName: isDragging ? 'cursor-grabbing' : isSpacePressed ? 'cursor-grab' : undefined,
    onClickCapture,
    onPointerDown,
    onPointerEnter,
    onPointerLeave
  }
}
