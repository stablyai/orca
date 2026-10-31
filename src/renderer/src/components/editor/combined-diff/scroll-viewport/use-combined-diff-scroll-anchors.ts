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
  scrollContainerRef,
  scrollOffsetRef,
  memoryLeaseRef,
  virtualizer
}: {
  restorationKey: string
  scrollAnchorRef: React.RefObject<VirtualizedScrollAnchor>
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  scrollOffsetRef: React.RefObject<number>
  memoryLeaseRef: React.RefObject<CombinedDiffViewLease | null>
  virtualizer: Virtualizer<HTMLDivElement, Element>
}): CombinedDiffScrollAnchors {
  const persistScrollAnchor = useCallback((): void => {
    const container = scrollContainerRef.current
    if (!container) {
      return
    }
    const state = getCombinedDiffExtent(container).exportView()
    scrollOffsetRef.current = state.scrollTop
    scrollAnchorRef.current = state.anchor ? { ...state.anchor, scrollTop: state.scrollTop } : null
    rememberCombinedDiffView(memoryLeaseRef.current, {
      scrollTop: state.scrollTop,
      scrollAnchor: scrollAnchorRef.current ?? undefined
    })
  }, [memoryLeaseRef, scrollAnchorRef, scrollContainerRef, scrollOffsetRef])

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    if (container) {
      getCombinedDiffExtent(container).importView({
        scrollTop: scrollOffsetRef.current,
        anchor: scrollAnchorRef.current
      })
    }
  }, [restorationKey, scrollAnchorRef, scrollContainerRef, scrollOffsetRef])

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    container?.addEventListener(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT, persistScrollAnchor)
    return () =>
      container?.removeEventListener(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT, persistScrollAnchor)
  }, [persistScrollAnchor, scrollContainerRef])

  const scrollToSectionIndex = useCallback(
    (index: number): void => {
      scrollCombinedDiffToIndex(virtualizer, index)
      persistScrollAnchor()
    },
    [persistScrollAnchor, virtualizer]
  )

  return { persistScrollAnchor, scrollToSectionIndex }
}
