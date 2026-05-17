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

function pointIsInsideElement(
  point: { x: number; y: number } | null,
  element: HTMLElement
): boolean {
  if (!point) {
    return false
  }
  const rect = element.getBoundingClientRect()
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  )
}

export function useWorkspaceKanbanShiftWheelScroll(
  boardRef: React.RefObject<HTMLElement | null>,
  scrollerRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  isPointerDragActiveRef?: React.RefObject<boolean>
): void {
  useEffect(() => {
    if (!enabled) {
      return
    }

    let isWorkspaceDragActive = false
    let lastDragPoint: { x: number; y: number } | null = null

    const stopTrackingDrag = (): void => {
      isWorkspaceDragActive = false
      lastDragPoint = null
    }

    const handleDragStart = (event: DragEvent): void => {
      isWorkspaceDragActive = event.dataTransfer ? hasWorkspaceDragData(event.dataTransfer) : false
      lastDragPoint = isWorkspaceDragActive ? { x: event.clientX, y: event.clientY } : null
    }

    const handleDragOver = (event: DragEvent): void => {
      if (!isWorkspaceDragActive) {
        return
      }
      lastDragPoint = { x: event.clientX, y: event.clientY }
    }

    const handleWheel = (event: WheelEvent): void => {
      const board = boardRef.current
      const scroller = scrollerRef.current
      const isPointerDragActive = isPointerDragActiveRef?.current === true
      if (
        !event.shiftKey ||
        (!isWorkspaceDragActive && !isPointerDragActive) ||
        !board ||
        !scroller ||
        (!isEventInsideElement(event, board) && !pointIsInsideElement(lastDragPoint, board))
      ) {
        return
      }

      const delta = getWheelPixels(event)
      if (delta === 0) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      scroller.scrollLeft += delta
    }

    document.addEventListener('dragstart', handleDragStart, true)
    document.addEventListener('dragover', handleDragOver, true)
    document.addEventListener('drop', stopTrackingDrag, true)
    document.addEventListener('dragend', stopTrackingDrag, true)
    window.addEventListener('blur', stopTrackingDrag)
    // Why: Chromium can cancel the native drag if Shift+wheel reaches default
    // scrolling first, so intercept before bubble listeners see the event.
    document.addEventListener('wheel', handleWheel, { capture: true, passive: false })
    return () => {
      document.removeEventListener('dragstart', handleDragStart, true)
      document.removeEventListener('dragover', handleDragOver, true)
      document.removeEventListener('drop', stopTrackingDrag, true)
      document.removeEventListener('dragend', stopTrackingDrag, true)
      window.removeEventListener('blur', stopTrackingDrag)
      document.removeEventListener('wheel', handleWheel, true)
    }
  }, [boardRef, enabled, isPointerDragActiveRef, scrollerRef])
}
