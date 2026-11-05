import React, { useCallback, useEffect, useRef } from 'react'

// Chromium keeps a native thumb at least about this tall on long lists.
const NATIVE_THUMB_MIN_HEIGHT = 18

type SidebarSeamScrollbarStripProps = {
  sidebarRef: React.RefObject<HTMLElement | null>
  onResizeStart: (event: React.MouseEvent) => void
}

function findSeamScrollContainer(sidebar: HTMLElement, clientY: number): HTMLElement | null {
  const seamX = sidebar.getBoundingClientRect().right
  let node = document.elementFromPoint(seamX - 2, clientY)
  while (node instanceof HTMLElement && sidebar.contains(node)) {
    const overflowY = getComputedStyle(node).overflowY
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight + 1 &&
      Math.abs(node.getBoundingClientRect().right - seamX) <= 1
    ) {
      return node
    }
    node = node.parentElement
  }
  return null
}

function getThumbGeometry(container: HTMLElement): {
  trackTop: number
  travel: number
  thumbTop: number
  thumbHeight: number
  maxScrollTop: number
} {
  const trackTop = container.getBoundingClientRect().top
  const trackHeight = container.clientHeight
  const maxScrollTop = Math.max(1, container.scrollHeight - container.clientHeight)
  const thumbHeight = Math.min(
    trackHeight,
    Math.max(
      NATIVE_THUMB_MIN_HEIGHT,
      (trackHeight * container.clientHeight) / container.scrollHeight
    )
  )
  const travel = Math.max(1, trackHeight - thumbHeight)
  return {
    trackTop,
    travel,
    thumbTop: trackTop + (container.scrollTop / maxScrollTop) * travel,
    thumbHeight,
    maxScrollTop
  }
}

/** Extends the sidebar list's scrollbar hit area a few pixels past the seam into the main pane. */
export function SidebarSeamScrollbarStrip({
  sidebarRef,
  onResizeStart
}: SidebarSeamScrollbarStripProps): React.JSX.Element {
  const endDragRef = useRef<(() => void) | null>(null)

  useEffect(() => () => endDragRef.current?.(), [])

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const sidebar = sidebarRef.current
      const overScrollbar = sidebar ? findSeamScrollContainer(sidebar, event.clientY) : null
      event.currentTarget.style.cursor = overScrollbar ? 'default' : 'col-resize'
    },
    [sidebarRef]
  )

  const handleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const sidebar = sidebarRef.current
      const container = sidebar ? findSeamScrollContainer(sidebar, event.clientY) : null
      if (!container) {
        onResizeStart(event)
        return
      }
      if (event.button !== 0) {
        return
      }
      event.preventDefault()
      endDragRef.current?.()

      const start = getThumbGeometry(container)
      const grabbedThumb =
        event.clientY >= start.thumbTop && event.clientY <= start.thumbTop + start.thumbHeight
      const grabOffset = grabbedThumb ? event.clientY - start.thumbTop : start.thumbHeight / 2

      const scrollToPointer = (clientY: number): void => {
        const geometry = getThumbGeometry(container)
        const thumbTop = Math.max(
          0,
          Math.min(geometry.travel, clientY - geometry.trackTop - grabOffset)
        )
        container.scrollTop = (thumbTop / geometry.travel) * geometry.maxScrollTop
      }
      if (!grabbedThumb) {
        scrollToPointer(event.clientY)
      }

      const onMove = (moveEvent: MouseEvent): void => {
        moveEvent.preventDefault()
        scrollToPointer(moveEvent.clientY)
      }
      // Why: a viewport overlay keeps mouseup over native plugins such as PDF embeds, preventing a stuck drag.
      const overlay = document.createElement('div')
      overlay.style.position = 'fixed'
      overlay.style.inset = '0'
      overlay.style.zIndex = '2147483647'
      const endDrag = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', endDrag)
        window.removeEventListener('blur', endDrag)
        overlay.remove()
        document.body.style.userSelect = ''
        endDragRef.current = null
      }
      document.body.appendChild(overlay)
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', endDrag)
      window.addEventListener('blur', endDrag)
      endDragRef.current = endDrag
    },
    [onResizeStart, sidebarRef]
  )

  return (
    <div
      data-sidebar-seam-scrollbar-strip=""
      className="absolute -right-1 top-0 z-10 h-full w-1"
      onMouseMove={handleMouseMove}
      onMouseDown={handleMouseDown}
    />
  )
}
