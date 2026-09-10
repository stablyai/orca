import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import {
  zoomMaestroViewportAtPointer,
  type MaestroCanvasSize,
  type MaestroCanvasViewport
} from './maestro-canvas-viewport'
import type { useMaestroViewportElementStyles } from './useMaestroViewportElementStyles'
import type { useMaestroViewportPersistence } from './useMaestroViewportPersistence'

export function useMaestroViewportWheel({
  viewportRef,
  size,
  setViewport,
  cancelAnimation,
  viewportStyles,
  persistence
}: {
  viewportRef: MutableRefObject<MaestroCanvasViewport>
  size: MaestroCanvasSize
  setViewport: Dispatch<SetStateAction<MaestroCanvasViewport>>
  cancelAnimation: (syncState: boolean) => void
  viewportStyles: ReturnType<typeof useMaestroViewportElementStyles>
  persistence: ReturnType<typeof useMaestroViewportPersistence>
}): {
  cancelWheelFrame: (syncState: boolean) => void
  onWheel: (event: React.WheelEvent<HTMLElement>) => void
} {
  const wheelFrameRef = useRef<number | null>(null)
  const cancelWheelFrame = useCallback(
    (syncState: boolean): void => {
      if (wheelFrameRef.current === null) {
        return
      }
      cancelAnimationFrame(wheelFrameRef.current)
      wheelFrameRef.current = null
      viewportStyles.flushPan()
      if (syncState) {
        setViewport(viewportRef.current)
      }
    },
    [setViewport, viewportRef, viewportStyles]
  )
  useEffect(() => () => cancelWheelFrame(false), [cancelWheelFrame])
  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLElement>): void => {
      if (event.target !== event.currentTarget) {
        return
      }
      event.preventDefault()
      cancelAnimation(false)
      const bounds = event.currentTarget.getBoundingClientRect()
      const current = viewportRef.current
      const scrollDelta =
        Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
      const next = event.shiftKey
        ? {
            ...current,
            center: { ...current.center, x: current.center.x + scrollDelta / current.zoom }
          }
        : event.ctrlKey || event.metaKey
          ? {
              ...current,
              center: { ...current.center, y: current.center.y + scrollDelta / current.zoom }
            }
          : zoomMaestroViewportAtPointer(
              current,
              size,
              { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
              current.zoom * Math.exp(-scrollDelta * 0.002)
            )
      viewportRef.current = next
      viewportStyles.schedulePan()
      if (wheelFrameRef.current === null) {
        wheelFrameRef.current = requestAnimationFrame(() => {
          wheelFrameRef.current = null
          viewportStyles.flushPan()
          setViewport(viewportRef.current)
          persistence.commit(viewportRef.current)
        })
      }
    },
    [cancelAnimation, persistence, setViewport, size, viewportRef, viewportStyles]
  )
  return { cancelWheelFrame, onWheel }
}
