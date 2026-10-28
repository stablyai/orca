import { useCallback, useEffect, useRef } from 'react'
import type React from 'react'
import { SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT } from '../../WorktreeCardAgents'
import {
  createPendingRevealScroll,
  isRevealScrollSettling,
  type PendingRevealScroll
} from '../../worktree-sidebar-reveal-scroll-settle'

export const USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS = 500
export const EXPANDING_CARD_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS = 300

export function shouldAdjustWorktreeSidebarMeasuredRowScroll(args: {
  isScrolling: boolean
  now: number
  suppressUntil: number
  itemStart: number
  itemEnd: number
  scrollOffset: number
  isFirstMeasurement: boolean
  scrollDirection: 'forward' | 'backward' | null
}): boolean {
  if (args.isScrolling || args.now < args.suppressUntil) {
    return false
  }
  // Preserve TanStack's fold rule so below-anchor growth cannot invent a scroll offset.
  return args.isFirstMeasurement
    ? args.itemStart < args.scrollOffset
    : args.itemEnd <= args.scrollOffset && args.scrollDirection !== 'backward'
}

export type WorktreeSidebarScrollSuppression = ReturnType<
  typeof useWorktreeSidebarScrollSuppression
>

// Track measurement suppression for all scrolling and anchor suppression for direct input or smooth reveals.
export function useWorktreeSidebarScrollSuppression(
  scrollRef: React.RefObject<HTMLDivElement | null>
) {
  const suppressMeasurementAdjustmentUntilRef = useRef(0)
  const directScrollInputUntilRef = useRef(0)
  const pendingRevealScrollRef = useRef<PendingRevealScroll | null>(null)

  const markScrollMovement = useCallback(() => {
    suppressMeasurementAdjustmentUntilRef.current =
      window.performance.now() + USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS
  }, [])
  const markDirectScrollInput = useCallback(() => {
    const suppressUntil = window.performance.now() + USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS
    suppressMeasurementAdjustmentUntilRef.current = suppressUntil
    directScrollInputUntilRef.current = suppressUntil
  }, [])
  const hasDirectScrollInput = useCallback(
    () => window.performance.now() < directScrollInputUntilRef.current,
    []
  )
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
  // Programmatic scrolling suppresses measurements; only direct input or an in-flight reveal blocks anchor restore.
  const shouldSkipScrollAnchorRestore = useCallback(
    () =>
      window.performance.now() < directScrollInputUntilRef.current || isRevealScrollSettlingNow(),
    [isRevealScrollSettlingNow]
  )

  useEffect(() => {
    const handleSuppress = () => {
      // Why: let an expanding agent row grow in place instead of TanStack compensating scrollTop.
      suppressMeasurementAdjustmentUntilRef.current =
        window.performance.now() + EXPANDING_CARD_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS
    }
    window.addEventListener(SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT, handleSuppress)
    return () => {
      window.removeEventListener(SUPPRESS_WORKTREE_LIST_SCROLL_ADJUSTMENT_EVENT, handleSuppress)
    }
  }, [])

  return {
    suppressMeasurementAdjustmentUntilRef,
    directScrollInputUntilRef,
    markScrollMovement,
    markDirectScrollInput,
    hasDirectScrollInput,
    markRevealScroll,
    shouldSkipScrollAnchorRestore
  }
}
