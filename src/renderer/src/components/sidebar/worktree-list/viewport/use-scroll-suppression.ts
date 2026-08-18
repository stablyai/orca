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
}): boolean {
  return !args.isScrolling && args.now >= args.suppressUntil
}

export type WorktreeSidebarScrollSuppression = ReturnType<
  typeof useWorktreeSidebarScrollSuppression
>

// Tracks the two suppression windows the virtualizer honours: measurement correction
// (any scroll movement) and anchor restore (direct user input or a settling reveal).
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
  // Why: programmatic scrolls keep measurement correction quiet, but only direct input blocks anchor-restore retries.
  // A reveal's smooth scroll is the exception: restoring the anchor mid-animation cancels it a few pixels in.
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
