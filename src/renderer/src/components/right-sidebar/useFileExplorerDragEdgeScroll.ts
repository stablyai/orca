import type { RefObject } from 'react'
import { useCallback, useRef } from 'react'
import { DRAG_EDGE_ZONE_PX, getDragEdgeScrollTarget } from './file-explorer-drag-edge-scroll'

type UseFileExplorerDragEdgeScrollResult = {
  startDragEdgeScroll: (clientY: number) => void
  stopDragEdgeScroll: () => void
}

export function useFileExplorerDragEdgeScroll(
  scrollRef: RefObject<HTMLDivElement | null>
): UseFileExplorerDragEdgeScrollResult {
  const lastDragClientYRef = useRef<number | null>(null)
  const edgeScrollRafRef = useRef<number | null>(null)

  const stopDragEdgeScroll = useCallback(() => {
    lastDragClientYRef.current = null
    if (edgeScrollRafRef.current !== null) {
      cancelAnimationFrame(edgeScrollRafRef.current)
      edgeScrollRafRef.current = null
    }
  }, [])

  // requestAnimationFrame + small per-frame deltas avoids choppy jumps from irregular dragover events
  const tickDragEdgeScroll = useCallback(() => {
    edgeScrollRafRef.current = null
    const viewport = scrollRef.current
    const clientY = lastDragClientYRef.current
    if (!viewport || clientY == null) {
      return
    }
    const rect = viewport.getBoundingClientRect()
    const y = clientY - rect.top
    const zone = DRAG_EDGE_ZONE_PX

    const nextScrollTop = getDragEdgeScrollTarget({
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
      localY: y,
      edgeZonePx: zone
    })

    if (nextScrollTop !== null) {
      viewport.scrollTop = nextScrollTop
      edgeScrollRafRef.current = requestAnimationFrame(tickDragEdgeScroll)
    }
  }, [scrollRef])

  const startDragEdgeScroll = useCallback(
    (clientY: number) => {
      lastDragClientYRef.current = clientY
      if (edgeScrollRafRef.current === null) {
        edgeScrollRafRef.current = requestAnimationFrame(tickDragEdgeScroll)
      }
    },
    [tickDragEdgeScroll]
  )

  return { startDragEdgeScroll, stopDragEdgeScroll }
}
