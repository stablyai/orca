import { useLayoutEffect, useRef } from 'react'
import type React from 'react'
import { getVirtualizedScrollAnchorForOffset } from '@/hooks/virtualized-scroll-anchor-recording'
import {
  VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT,
  type VirtualizedScrollAnchor
} from '@/hooks/useVirtualizedScrollAnchor'
import { sidebarSlotContentEnd, type SidebarGeometry } from '../listing/sidebar-geometry-slots'

export function useSidebarGeometryAnchor(args: {
  model: SidebarGeometry
  boundaries: readonly number[]
  retained: ReadonlySet<number>
  scrollRef: React.RefObject<HTMLDivElement | null>
  anchorRef: React.MutableRefObject<VirtualizedScrollAnchor>
  scrollOffsetRef: React.MutableRefObject<number>
  inset: number
  canCapture: () => boolean
}): void {
  const committed = useRef(args)
  const pendingCapture = useRef(false)
  const captureCommitted = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    committed.current = args
    if (pendingCapture.current) {
      captureCommitted.current?.()
    }
  })
  useLayoutEffect(() => {
    const element = args.scrollRef.current
    if (!element) {
      return
    }
    const capture = () => {
      const { model, boundaries, retained, anchorRef, scrollOffsetRef, inset, canCapture } =
        committed.current
      if (!canCapture()) {
        return
      }
      const items = [...retained]
        .sort((a, b) => a - b)
        .map((index) => {
          const node = model.nodes[index]!
          return {
            index,
            start: boundaries[node.slot]! + inset,
            end: sidebarSlotContentEnd(model, boundaries, node.slot) + inset
          }
        })
        .filter(
          (item) =>
            item.end > element.scrollTop && item.start < element.scrollTop + element.clientHeight
        )
      scrollOffsetRef.current = element.scrollTop
      anchorRef.current = getVirtualizedScrollAnchorForOffset({
        rows: model.nodes,
        getRowKey: (node) => node.key,
        scrollTop: element.scrollTop,
        virtualItems: items
      })
      pendingCapture.current = items.length === 0
    }
    captureCommitted.current = capture
    const requestCapture = () => {
      pendingCapture.current = true
      capture()
      // Scroll fires before React commits the destination range.
      pendingCapture.current = true
    }
    element.addEventListener('scroll', requestCapture, { passive: true })
    element.addEventListener(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT, requestCapture)
    return () => {
      capture()
      captureCommitted.current = null
      element.removeEventListener('scroll', requestCapture)
      element.removeEventListener(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT, requestCapture)
    }
  }, [args.scrollRef])
}
