import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createHardScrollUpDetectorState,
  HARD_SCROLL_UP,
  reduceHardScrollUpOnDismiss,
  reduceHardScrollUpOnIdle,
  reduceHardScrollUpOnScroll,
  reduceHardScrollUpOnWheel,
  type HardScrollUpDetectorState
} from './worktree-list-hard-scroll-up'

function readViewport(element: HTMLElement): { scrollTop: number; maxScroll: number } {
  const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight)
  return {
    scrollTop: element.scrollTop,
    maxScroll
  }
}

function shouldForceHide(viewport: { scrollTop: number; maxScroll: number }): boolean {
  return (
    viewport.scrollTop <= HARD_SCROLL_UP.nearTopPx ||
    viewport.maxScroll < HARD_SCROLL_UP.minScrollablePx
  )
}

/**
 * Offers a jump-to-top affordance when the user is hard-scrolling up a long
 * worktree list (common with smart/agent-activity ranking).
 *
 * Visibility is deadline-based from `lastIntentAt` so scroll noise cannot keep
 * the button stuck forever.
 */
export function useWorktreeListScrollToTop({
  scrollElement,
  onUserScrollIntent
}: {
  scrollElement: HTMLElement | null
  /** Called when the user clicks jump-to-top so virtualizer scroll guards engage. */
  onUserScrollIntent?: () => void
}): {
  showScrollToTop: boolean
  scrollToTop: () => void
} {
  const detectorRef = useRef<HardScrollUpDetectorState>(createHardScrollUpDetectorState())
  const [showScrollToTop, setShowScrollToTop] = useState(false)
  const showScrollToTopRef = useRef(false)
  const idleTimerRef = useRef<number | null>(null)
  const scrollbarDragRef = useRef(false)
  const touchScrollRef = useRef(false)
  // Why: jump-to-top can still emit a burst of scroll events; ignore them briefly so the button does not reappear.
  const suppressDetectionUntilRef = useRef(0)

  const publishVisible = useCallback((next: HardScrollUpDetectorState) => {
    detectorRef.current = next
    if (showScrollToTopRef.current !== next.visible) {
      showScrollToTopRef.current = next.visible
      setShowScrollToTop(next.visible)
    }
  }, [])

  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
  }, [])

  // Arm once per intent timestamp; do not reset on every scroll tick (that stuck the button).
  const armIdleHide = useCallback(
    (element: HTMLElement, lastIntentAt: number) => {
      clearIdleTimer()
      const fireAt = lastIntentAt + HARD_SCROLL_UP.hideAfterIdleMs
      const delayMs = Math.max(0, fireAt - window.performance.now())

      idleTimerRef.current = window.setTimeout(() => {
        idleTimerRef.current = null
        const now = window.performance.now()

        // Jump-to-top already dismissed; if a stale timer lands in the suppress window, force-hide.
        if (now < suppressDetectionUntilRef.current) {
          publishVisible(createHardScrollUpDetectorState())
          return
        }

        const viewport = readViewport(element)
        const next = reduceHardScrollUpOnIdle(detectorRef.current, {
          ...viewport,
          t: now
        })
        // Belt-and-suspenders: if still visible past the deadline, force dismiss.
        if (next.visible && now - next.lastIntentAt >= HARD_SCROLL_UP.hideAfterIdleMs) {
          publishVisible(createHardScrollUpDetectorState())
          return
        }
        publishVisible(next)
      }, delayMs)
    },
    [clearIdleTimer, publishVisible]
  )

  const applyDetectorResult = useCallback(
    (
      element: HTMLElement,
      previous: HardScrollUpDetectorState,
      next: HardScrollUpDetectorState
    ) => {
      publishVisible(next)
      if (!next.visible) {
        clearIdleTimer()
        return
      }
      // Only re-arm when intent is refreshed; scroll spam must not extend lifetime.
      if (next.lastIntentAt !== previous.lastIntentAt) {
        armIdleHide(element, next.lastIntentAt)
      }
    },
    [armIdleHide, clearIdleTimer, publishVisible]
  )

  useEffect(() => {
    if (!scrollElement) {
      clearIdleTimer()
      publishVisible(createHardScrollUpDetectorState())
      return
    }

    const onWheel = (event: WheelEvent): void => {
      const now = window.performance.now()
      const viewport = readViewport(scrollElement)

      // Always allow force-hide even while jump-to-top is suppressing detection.
      if (shouldForceHide(viewport)) {
        publishVisible(createHardScrollUpDetectorState())
        clearIdleTimer()
        return
      }

      if (now < suppressDetectionUntilRef.current) {
        return
      }

      const previous = detectorRef.current
      const next = reduceHardScrollUpOnWheel(previous, {
        ...viewport,
        t: now,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode
      })
      applyDetectorResult(scrollElement, previous, next)
    }

    const onScroll = (): void => {
      const now = window.performance.now()
      const viewport = readViewport(scrollElement)

      if (shouldForceHide(viewport)) {
        publishVisible(createHardScrollUpDetectorState())
        clearIdleTimer()
        return
      }

      if (now < suppressDetectionUntilRef.current) {
        return
      }

      // Scroll events do not expose their origin; only velocity-detect gestures we observed directly.
      if (!scrollbarDragRef.current && !touchScrollRef.current) {
        return
      }

      const previous = detectorRef.current
      const next = reduceHardScrollUpOnScroll(previous, {
        ...viewport,
        t: now
      })
      applyDetectorResult(scrollElement, previous, next)
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') {
        touchScrollRef.current = true
        return
      }
      const rect = scrollElement.getBoundingClientRect()
      const nativeScrollbarWidth = scrollElement.offsetWidth - scrollElement.clientWidth
      const scrollbarHitWidth = Math.max(12, nativeScrollbarWidth)
      scrollbarDragRef.current =
        event.target === scrollElement && event.clientX >= rect.right - scrollbarHitWidth
    }

    const onPointerEnd = (): void => {
      scrollbarDragRef.current = false
      touchScrollRef.current = false
    }

    scrollElement.addEventListener('wheel', onWheel, { passive: true })
    scrollElement.addEventListener('scroll', onScroll, { passive: true })
    scrollElement.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('pointerup', onPointerEnd, { passive: true })
    window.addEventListener('pointercancel', onPointerEnd, { passive: true })
    return () => {
      scrollElement.removeEventListener('wheel', onWheel)
      scrollElement.removeEventListener('scroll', onScroll)
      scrollElement.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerEnd)
      window.removeEventListener('pointercancel', onPointerEnd)
      onPointerEnd()
      clearIdleTimer()
    }
  }, [applyDetectorResult, clearIdleTimer, publishVisible, scrollElement])

  const scrollToTop = useCallback(() => {
    if (!scrollElement) {
      return
    }
    onUserScrollIntent?.()
    publishVisible(reduceHardScrollUpOnDismiss(detectorRef.current))
    clearIdleTimer()
    suppressDetectionUntilRef.current =
      window.performance.now() + HARD_SCROLL_UP.suppressAfterJumpMs
    scrollElement.scrollTo({ top: 0, behavior: 'auto' })
    scrollElement.focus({ preventScroll: true })
  }, [clearIdleTimer, onUserScrollIntent, publishVisible, scrollElement])

  return {
    showScrollToTop,
    scrollToTop
  }
}
