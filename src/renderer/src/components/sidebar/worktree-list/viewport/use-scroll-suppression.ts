import {
  requestVirtualizedScrollAnchorRecord,
  supersedeVirtualizedScrollAnchorRestore
} from '@/hooks/requestVirtualizedScrollAnchorRecord'
import { useCallback, useRef } from 'react'
import type React from 'react'
import {
  createPendingRevealScroll,
  isRevealScrollSettling,
  type PendingRevealScroll
} from '../navigation/worktree-sidebar-reveal-scroll-settle'

export type WorktreeSidebarScrollSuppression = ReturnType<
  typeof useWorktreeSidebarScrollSuppression
>

// Explicit input retires the previous target; smooth reveal owns its settling position.
export function useWorktreeSidebarScrollSuppression(
  scrollRef: React.RefObject<HTMLDivElement | null>
) {
  const pendingRevealScrollRef = useRef<PendingRevealScroll | null>(null)
  const cancelRevealScroll = useCallback(() => {
    pendingRevealScrollRef.current = null
  }, [])

  const markDirectScrollInput = useCallback(() => {
    supersedeVirtualizedScrollAnchorRestore(scrollRef.current)
    cancelRevealScroll()
    requestVirtualizedScrollAnchorRecord(scrollRef.current, { deferDomMeasurement: true })
  }, [cancelRevealScroll, scrollRef])
  const markRevealScroll = useCallback((targetTop: number) => {
    pendingRevealScrollRef.current = createPendingRevealScroll(targetTop, window.performance.now())
  }, [])
  const isRevealScrollSettlingNow = useCallback(() => {
    const settling = isRevealScrollSettling({
      now: window.performance.now(),
      pending: pendingRevealScrollRef.current,
      scrollTop: scrollRef.current?.scrollTop ?? 0
    })
    if (!settling) {
      pendingRevealScrollRef.current = null
    }
    return settling
  }, [scrollRef])

  return {
    cancelRevealScroll,
    markDirectScrollInput,
    markRevealScroll,
    shouldSkipScrollAnchorRestore: isRevealScrollSettlingNow
  }
}
