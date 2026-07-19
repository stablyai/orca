import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '../../store'
import {
  resolveDividerRatioFromPointer,
  type WorkspaceSplitDividerDescriptor
} from './workspace-split-frames'

/** Absolutely-positioned resize handles for the workspace pane tree, one per
 *  split node. Rendered after the pane surfaces so they paint above them.
 *  Reuses the tab-group divider CSS for a consistent look. */
export default function WorkspaceSplitDividers({
  dividers,
  containerRef
}: {
  dividers: WorkspaceSplitDividerDescriptor[]
  containerRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element | null {
  const setWorkspaceSplitRatio = useAppStore((s) => s.setWorkspaceSplitRatio)
  const activeDragCleanupRef = useRef<(() => void) | null>(null)

  useEffect(
    () => () => {
      activeDragCleanupRef.current?.()
    },
    []
  )

  const onDividerPointerDown = useCallback(
    (divider: WorkspaceSplitDividerDescriptor, event: React.PointerEvent<HTMLDivElement>) => {
      const container = containerRef.current
      if (!container) {
        return
      }
      event.preventDefault()
      const handle = event.currentTarget
      activeDragCleanupRef.current?.()
      handle.setPointerCapture(event.pointerId)
      handle.classList.add('is-dragging')

      const onPointerMove = (moveEvent: PointerEvent): void => {
        if (!handle.hasPointerCapture(event.pointerId)) {
          return
        }
        const rect = container.getBoundingClientRect()
        setWorkspaceSplitRatio(
          divider.path,
          resolveDividerRatioFromPointer(divider, rect, moveEvent)
        )
      }

      let cleaned = false
      const cleanup = (): void => {
        if (cleaned) {
          return
        }
        cleaned = true
        handle.classList.remove('is-dragging')
        try {
          if (handle.hasPointerCapture(event.pointerId)) {
            handle.releasePointerCapture(event.pointerId)
          }
        } catch {
          // Best effort: unmount cleanup can run after Chromium dropped capture.
        }
        handle.removeEventListener('pointermove', onPointerMove)
        handle.removeEventListener('pointerup', cleanup)
        handle.removeEventListener('pointercancel', cleanup)
        handle.removeEventListener('lostpointercapture', cleanup)
        if (activeDragCleanupRef.current === cleanup) {
          activeDragCleanupRef.current = null
        }
      }

      handle.addEventListener('pointermove', onPointerMove)
      handle.addEventListener('pointerup', cleanup)
      handle.addEventListener('pointercancel', cleanup)
      handle.addEventListener('lostpointercapture', cleanup)
      activeDragCleanupRef.current = cleanup
    },
    [containerRef, setWorkspaceSplitRatio]
  )

  if (dividers.length === 0) {
    return null
  }

  return (
    <>
      {dividers.map((divider) => {
        const isVerticalLine = divider.direction === 'horizontal'
        return (
          <div
            key={divider.path.join('.') || 'root'}
            className={`tab-group-split-resize-handle ${
              isVerticalLine ? 'is-vertical' : 'is-horizontal'
            }`}
            style={
              isVerticalLine
                ? {
                    position: 'absolute',
                    zIndex: 20,
                    left: `calc(${divider.linePosition}% - 3px)`,
                    top: `${divider.crossStart}%`,
                    height: `${divider.crossLength}%`
                  }
                : {
                    position: 'absolute',
                    zIndex: 20,
                    top: `calc(${divider.linePosition}% - 3px)`,
                    left: `${divider.crossStart}%`,
                    width: `${divider.crossLength}%`
                  }
            }
            onPointerDown={(event) => onDividerPointerDown(divider, event)}
            onDoubleClick={() => setWorkspaceSplitRatio(divider.path, 0.5)}
          />
        )
      })}
    </>
  )
}
