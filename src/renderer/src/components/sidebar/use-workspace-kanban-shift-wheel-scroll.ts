import { useEffect } from 'react'
import type React from 'react'
import { hasWorkspaceDragData } from './workspace-status'

function getWheelPixels(event: WheelEvent): number {
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : window.innerHeight
  if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
    return event.deltaY || event.deltaX
  }
  return (event.deltaY || event.deltaX) * unit
}

function isEventInsideElement(event: WheelEvent, element: HTMLElement): boolean {
  const target = event.target
  if (target instanceof Node && element.contains(target)) {
    return true
  }
  const rect = element.getBoundingClientRect()
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  )
}

export function useWorkspaceKanbanShiftWheelScroll(
  boardRef: React.RefObject<HTMLElement | null>,
  scrollerRef: React.RefObject<HTMLElement | null>,
  enabled: boolean
): void {
  useEffect(() => {
    if (!enabled) {
      return
    }

    let isWorkspaceDragActive = false

    const stopTrackingDrag = (): void => {
      isWorkspaceDragActive = false
    }

    const handleDragStart = (event: DragEvent): void => {
      isWorkspaceDragActive = event.dataTransfer ? hasWorkspaceDragData(event.dataTransfer) : false
    }

    const handleWheel = (event: WheelEvent): void => {
      const board = boardRef.current
      const scroller = scrollerRef.current
      if (
        !event.shiftKey ||
        !isWorkspaceDragActive ||
        !board ||
        !scroller ||
        !isEventInsideElement(event, board)
      ) {
        return
      }

      const delta = getWheelPixels(event)
      if (delta === 0) {
        return
      }
      event.preventDefault()
      scroller.scrollLeft += delta
    }

    document.addEventListener('dragstart', handleDragStart)
    document.addEventListener('drop', stopTrackingDrag, true)
    document.addEventListener('dragend', stopTrackingDrag, true)
    window.addEventListener('blur', stopTrackingDrag)
    document.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      document.removeEventListener('dragstart', handleDragStart)
      document.removeEventListener('drop', stopTrackingDrag, true)
      document.removeEventListener('dragend', stopTrackingDrag, true)
      window.removeEventListener('blur', stopTrackingDrag)
      document.removeEventListener('wheel', handleWheel)
    }
  }, [boardRef, enabled, scrollerRef])
}
