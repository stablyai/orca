import { getCombinedDiffExtent, scrollCombinedDiffToIndex } from '../../combined-diff-extent-dom'
import { useCallback, useLayoutEffect } from 'react'
import type React from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import {
  VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT,
  type VirtualizedScrollAnchor
} from '@/hooks/useVirtualizedScrollAnchor'
import {
  rememberCombinedDiffView,
  type CombinedDiffViewLease
} from '../remember-view/combined-diff-view-cache'

export type CombinedDiffScrollAnchors = {
  persistScrollAnchor: () => void
  scrollToSectionIndex: (index: number) => void
}

export function useCombinedDiffScrollAnchors({
  restorationKey,
  scrollAnchorRef,
  viewportNode,
  beforeDetachRef,
  releaseViewport,
  scrollOffsetRef,
  memoryLeaseRef,
  virtualizer
}: {
  restorationKey: string
  scrollAnchorRef: React.RefObject<VirtualizedScrollAnchor>
  viewportNode: HTMLDivElement | null
  beforeDetachRef: React.RefObject<(() => void) | null>
  releaseViewport: () => void
  scrollOffsetRef: React.RefObject<number>
  memoryLeaseRef: React.RefObject<CombinedDiffViewLease | null>
  virtualizer: Virtualizer<HTMLDivElement, Element>
}): CombinedDiffScrollAnchors {
  const persistScrollAnchor = useCallback((): void => {
    if (!viewportNode) {
      return
    }
    const state = getCombinedDiffExtent(viewportNode).exportView()
    scrollOffsetRef.current = state.scrollTop
    scrollAnchorRef.current = state.anchor ? { ...state.anchor, scrollTop: state.scrollTop } : null
    rememberCombinedDiffView(memoryLeaseRef.current, {
      scrollTop: state.scrollTop,
      scrollAnchor: scrollAnchorRef.current ?? undefined
    })
  }, [memoryLeaseRef, scrollAnchorRef, viewportNode, scrollOffsetRef])

  useLayoutEffect(() => {
    if (!viewportNode) {
      return
    }
    const owner = getCombinedDiffExtent(viewportNode)
    const lease = memoryLeaseRef.current
    owner.importView({ scrollTop: scrollOffsetRef.current, anchor: scrollAnchorRef.current })
    const record = (): void => {
      const state = owner.exportView()
      const anchor = state.anchor ? { ...state.anchor, scrollTop: state.scrollTop } : null
      scrollOffsetRef.current = state.scrollTop
      scrollAnchorRef.current = anchor
      rememberCombinedDiffView(lease, {
        scrollTop: state.scrollTop,
        scrollAnchor: anchor ?? undefined
      })
    }
    viewportNode.addEventListener('scroll', record, { passive: true })
    viewportNode.addEventListener(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT, record)
    beforeDetachRef.current = () => {
      record()
      viewportNode.removeEventListener('scroll', record)
      viewportNode.removeEventListener(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT, record)
    }
    return releaseViewport
  }, [
    beforeDetachRef,
    releaseViewport,
    restorationKey,
    memoryLeaseRef,
    scrollAnchorRef,
    viewportNode,
    scrollOffsetRef
  ])

  const scrollToSectionIndex = useCallback(
    (index: number): void => {
      scrollCombinedDiffToIndex(virtualizer, index)
      persistScrollAnchor()
    },
    [persistScrollAnchor, virtualizer]
  )

  return { persistScrollAnchor, scrollToSectionIndex }
}
