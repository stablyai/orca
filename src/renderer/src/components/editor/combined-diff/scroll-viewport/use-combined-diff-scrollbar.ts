import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import {
  beginCombinedDiffScrollbarDrag,
  type CombinedDiffScrollbarDragCleanup
} from './combined-diff-scrollbar-drag'

const COMBINED_DIFF_SCROLLBAR_THUMB_MIN_HEIGHT = 64

export type CombinedDiffScrollThumb = {
  visible: boolean
  top: number
  height: number
}

export type CombinedDiffScrollbar = {
  cleanupActiveScrollbarDrag: () => void
  handleScrollbarPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  scrollThumb: CombinedDiffScrollThumb
  updateScrollbar: () => void
}

export function useCombinedDiffScrollbar({
  markDirectScrollInput,
  scrollContainerRef
}: {
  markDirectScrollInput: () => void
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
}): CombinedDiffScrollbar {
  const [scrollThumb, setScrollThumb] = useState<CombinedDiffScrollThumb>({
    visible: false,
    top: 0,
    height: COMBINED_DIFF_SCROLLBAR_THUMB_MIN_HEIGHT
  })
  const activeScrollbarDragCleanupRef = useRef<CombinedDiffScrollbarDragCleanup | null>(null)

  const updateScrollbar = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container || container.scrollHeight <= container.clientHeight + 1) {
      setScrollThumb((prev) =>
        prev.visible
          ? {
              visible: false,
              top: 0,
              height: COMBINED_DIFF_SCROLLBAR_THUMB_MIN_HEIGHT
            }
          : prev
      )
      return
    }

    const trackHeight = Math.max(1, container.clientHeight - 8)
    const maxScrollTop = Math.max(1, container.scrollHeight - container.clientHeight)
    const height = Math.min(
      trackHeight,
      Math.max(
        COMBINED_DIFF_SCROLLBAR_THUMB_MIN_HEIGHT,
        (container.clientHeight / container.scrollHeight) * trackHeight
      )
    )
    const top = ((trackHeight - height) * container.scrollTop) / maxScrollTop
    setScrollThumb({ visible: true, top, height })
  }, [scrollContainerRef])

  const cleanupActiveScrollbarDrag = useCallback((): void => {
    activeScrollbarDragCleanupRef.current?.()
  }, [])

  useEffect(() => cleanupActiveScrollbarDrag, [cleanupActiveScrollbarDrag])

  const handleScrollbarPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const container = scrollContainerRef.current
      if (!container) {
        return
      }

      event.preventDefault()
      markDirectScrollInput()
      const track = event.currentTarget
      const thumb =
        event.target instanceof HTMLElement
          ? event.target.closest('[data-combined-diff-scrollbar-thumb]')
          : null

      const getLiveThumbHeight = (): number => {
        const trackHeight = Math.max(1, track.getBoundingClientRect().height)
        return Math.min(
          trackHeight,
          Math.max(
            COMBINED_DIFF_SCROLLBAR_THUMB_MIN_HEIGHT,
            (container.clientHeight / container.scrollHeight) * trackHeight
          )
        )
      }

      const getScrollTopForPointer = (clientY: number, grabOffset: number): number => {
        const trackRect = track.getBoundingClientRect()
        const trackHeight = Math.max(1, trackRect.height)
        const thumbHeight = getLiveThumbHeight()
        const maxThumbTop = Math.max(1, trackHeight - thumbHeight)
        const maxScrollTop = Math.max(1, container.scrollHeight - container.clientHeight)
        const thumbTop = Math.max(0, Math.min(maxThumbTop, clientY - trackRect.top - grabOffset))
        return (thumbTop / maxThumbTop) * maxScrollTop
      }

      const grabOffset = thumb
        ? event.clientY - thumb.getBoundingClientRect().top
        : getLiveThumbHeight() / 2

      if (!thumb) {
        container.scrollTop = getScrollTopForPointer(event.clientY, grabOffset)
        updateScrollbar()
      }

      const handlePointerMove = (moveEvent: PointerEvent): void => {
        moveEvent.preventDefault()
        markDirectScrollInput()
        container.scrollTop = getScrollTopForPointer(moveEvent.clientY, grabOffset)
        updateScrollbar()
      }
      cleanupActiveScrollbarDrag()
      let cleanupPointerDrag: CombinedDiffScrollbarDragCleanup
      cleanupPointerDrag = beginCombinedDiffScrollbarDrag({
        track,
        pointerId: event.pointerId,
        onPointerMove: handlePointerMove,
        onEnd: () => {
          if (activeScrollbarDragCleanupRef.current === cleanupPointerDrag) {
            activeScrollbarDragCleanupRef.current = null
          }
        }
      })
      activeScrollbarDragCleanupRef.current = cleanupPointerDrag
    },
    [cleanupActiveScrollbarDrag, markDirectScrollInput, scrollContainerRef, updateScrollbar]
  )

  return { cleanupActiveScrollbarDrag, handleScrollbarPointerDown, scrollThumb, updateScrollbar }
}
