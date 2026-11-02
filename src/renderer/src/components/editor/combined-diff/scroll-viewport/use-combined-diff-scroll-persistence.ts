import { useLayoutEffect } from 'react'
import type React from 'react'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import type { ProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import type { DiffSection } from '../../diff-section-types'
import {
  readCombinedDiffViewMemory,
  rememberCombinedDiffView,
  type CombinedDiffViewLease
} from '../remember-view/combined-diff-view-cache'
import type { CombinedDiffScrollAnchors } from './use-combined-diff-scroll-anchors'

export function useCombinedDiffScrollPersistence({
  anchors,
  entrySignature,
  hasDirectScrollInput,
  latestDomScrollAnchorRef,
  memoryLeaseRef,
  programmaticScrollMarks,
  scrollAnchorRef,
  scrollContainerRef,
  scrollOffsetRef,
  sectionCount,
  sectionHeights,
  sections,
  setClampRestoreCount,
  updateScrollbar,
  viewStateKey
}: {
  anchors: CombinedDiffScrollAnchors
  entrySignature: string
  hasDirectScrollInput: () => boolean
  latestDomScrollAnchorRef: React.RefObject<VirtualizedScrollAnchor>
  memoryLeaseRef: React.RefObject<CombinedDiffViewLease | null>
  programmaticScrollMarks: ProgrammaticScrollMarks
  scrollAnchorRef: React.RefObject<VirtualizedScrollAnchor>
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  scrollOffsetRef: React.RefObject<number>
  sectionCount: number
  sectionHeights: Record<number, number>
  sections: DiffSection[]
  setClampRestoreCount: React.Dispatch<React.SetStateAction<number>>
  updateScrollbar: () => void
  viewStateKey: string
}): void {
  const { persistScrollAnchor, recordVirtualScrollAnchor, writeScrollAnchor } = anchors

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    if (!container) {
      return
    }

    const memory = readCombinedDiffViewMemory(viewStateKey)
    if (memory?.view && memory.view.entrySignature === entrySignature) {
      scrollOffsetRef.current = memory.scrollTop ?? 0
    }

    let anchorIdleTimerId: number | null = null
    let anchorFrameId: number | null = null
    const cancelScheduledAnchorPersist = (): void => {
      if (anchorIdleTimerId !== null) {
        window.clearTimeout(anchorIdleTimerId)
        anchorIdleTimerId = null
      }
      if (anchorFrameId !== null) {
        window.cancelAnimationFrame(anchorFrameId)
        anchorFrameId = null
      }
    }
    const scheduleSettledAnchorPersist = (): void => {
      cancelScheduledAnchorPersist()
      anchorIdleTimerId = window.setTimeout(() => {
        anchorIdleTimerId = null
        if (hasDirectScrollInput()) {
          // Idle timers can fire mid-wheel while TanStack’s virtual window is still transitional.
          scheduleSettledAnchorPersist()
          return
        }
        anchorFrameId = window.requestAnimationFrame(() => {
          anchorFrameId = null
          persistScrollAnchor()
        })
      }, 150)
    }

    const updateCachedScrollPosition = ({
      recordDomAnchor,
      scheduleSettled,
      scrollTop,
      writeAnchor
    }: {
      recordDomAnchor: boolean
      scheduleSettled: boolean
      scrollTop: number
      writeAnchor: boolean
    }): void => {
      scrollOffsetRef.current = scrollTop
      if (writeAnchor) {
        if (recordDomAnchor) {
          persistScrollAnchor()
        } else {
          writeScrollAnchor()
        }
      }
      if (scheduleSettled) {
        scheduleSettledAnchorPersist()
      }
      updateScrollbar()
      rememberCombinedDiffView(memoryLeaseRef.current, { scrollTop })
    }
    let lastScrollHeight = container.scrollHeight
    const handleScroll = (event: Event): void => {
      const scrollTop = container.scrollTop
      const scrollHeight = container.scrollHeight
      const maxScrollTop = Math.max(0, scrollHeight - container.clientHeight)
      const shrank = scrollHeight < lastScrollHeight - 1
      lastScrollHeight = scrollHeight
      if (programmaticScrollMarks.consume(event, scrollTop, maxScrollTop)) {
        updateScrollbar()
        return
      }
      if (shrank && scrollTop >= maxScrollTop - 1 && scrollOffsetRef.current > maxScrollTop + 1) {
        // A newly unreachable offset clamped to max is browser layout, not user intent; restore the anchor instead of recording it.
        setClampRestoreCount((count) => count + 1)
        updateScrollbar()
        return
      }
      // Unmarked scrolls are user intent even if main-thread jank delays their events.
      recordVirtualScrollAnchor(scrollTop)
      updateCachedScrollPosition({
        recordDomAnchor: false,
        scheduleSettled: true,
        scrollTop,
        writeAnchor: true
      })
    }

    // Detach during layout so outgoing tabs snapshot before teardown emits a reset-to-top scroll.
    updateScrollbar()
    const resizeObserver = new ResizeObserver(updateScrollbar)
    resizeObserver.observe(container)
    container.addEventListener('scroll', handleScroll)
    return () => {
      cancelScheduledAnchorPersist()
      if (latestDomScrollAnchorRef.current) {
        scrollAnchorRef.current = latestDomScrollAnchorRef.current
      }
      updateCachedScrollPosition({
        recordDomAnchor: false,
        scheduleSettled: false,
        scrollTop: scrollOffsetRef.current,
        writeAnchor: true
      })
      resizeObserver.disconnect()
      container.removeEventListener('scroll', handleScroll)
    }
  }, [
    entrySignature,
    hasDirectScrollInput,
    latestDomScrollAnchorRef,
    memoryLeaseRef,
    persistScrollAnchor,
    programmaticScrollMarks,
    recordVirtualScrollAnchor,
    scrollAnchorRef,
    scrollContainerRef,
    scrollOffsetRef,
    sectionCount,
    setClampRestoreCount,
    updateScrollbar,
    writeScrollAnchor,
    viewStateKey
  ])

  useLayoutEffect(() => {
    updateScrollbar()
    const container = scrollContainerRef.current
    if (!container || container.scrollTop <= 0) {
      return
    }

    let frameId: number | null = null
    const timerId = window.setTimeout(() => {
      if (!container.isConnected || hasDirectScrollInput()) {
        return
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null
        persistScrollAnchor()
      })
    }, 300)

    return () => {
      window.clearTimeout(timerId)
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId)
      }
    }
  }, [
    hasDirectScrollInput,
    persistScrollAnchor,
    scrollContainerRef,
    sectionHeights,
    sections,
    updateScrollbar
  ])
}
