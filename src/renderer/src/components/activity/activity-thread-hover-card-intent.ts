import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'

// The pointer must rest this long on a row before its details card opens.
export const ACTIVITY_HOVER_CARD_REST_MS = 550
// The rest-progress line waits this long so crossing rows doesn't flash it.
export const ACTIVITY_HOVER_CARD_PROGRESS_DELAY_MS = 150
// Right after a card was showing, a short rest is enough to switch rows.
export const ACTIVITY_HOVER_CARD_WARM_REST_MS = 120
const WARM_WINDOW_MS = 400

// Module-level so a row that slides under a still pointer compares against what the previous row saw.
let lastPointerPosition: { x: number; y: number } | null = null
let openCardCount = 0
let lastCardClosedAt = Number.NEGATIVE_INFINITY

// Why: scrolling slides rows under a still pointer and Chromium fires hover events at the
// unchanged coordinates. Only a pointer that actually moved signals intent to peek.
function recordPointerMove(x: number, y: number): boolean {
  const moved = lastPointerPosition?.x !== x || lastPointerPosition?.y !== y
  lastPointerPosition = { x, y }
  return moved
}

function isKeyboardFocus(target: EventTarget): boolean {
  return target instanceof Element && target.matches(':focus-visible')
}

export function _resetActivityHoverCardIntentForTest(): void {
  lastPointerPosition = null
  openCardCount = 0
  lastCardClosedAt = Number.NEGATIVE_INFINITY
}

type RestTimers = { progress: number | undefined; open: number }

// Replaces Radix's open-on-enter with open-on-rest; Radix still owns closing on leave/blur.
export function useActivityThreadHoverCardIntent({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [resting, setResting] = useState(false)
  const triggerRef = useRef<HTMLElement | null>(null)
  const restTimersRef = useRef<RestTimers | null>(null)
  const detachScrollWatchRef = useRef<(() => void) | null>(null)
  const closedByScrollRef = useRef(false)
  const latestRef = useRef({ open, onOpenChange })
  useEffect(() => {
    latestRef.current = { open, onOpenChange }
  })

  const clearRestTimers = useCallback(() => {
    const timers = restTimersRef.current
    if (timers) {
      window.clearTimeout(timers.progress)
      window.clearTimeout(timers.open)
      restTimersRef.current = null
    }
  }, [])

  const cancelRest = useCallback(() => {
    clearRestTimers()
    setResting(false)
  }, [clearRestTimers])

  // Watch scrolls only while a rest is pending or the card is open, to stay off the hot path.
  const syncScrollWatch = useCallback(() => {
    const needed = latestRef.current.open || restTimersRef.current !== null
    if (!needed) {
      detachScrollWatchRef.current?.()
      detachScrollWatchRef.current = null
      return
    }
    const trigger = triggerRef.current
    if (detachScrollWatchRef.current || !trigger) {
      return
    }
    const handleScroll = (event: Event): void => {
      // Scrolls inside the portaled card (or anywhere unrelated) don't move this row.
      if (!(event.target instanceof Node) || !event.target.contains(trigger)) {
        return
      }
      clearRestTimers()
      setResting(false)
      if (latestRef.current.open) {
        closedByScrollRef.current = true
        latestRef.current.onOpenChange(false)
      }
    }
    document.addEventListener('scroll', handleScroll, { capture: true, passive: true })
    detachScrollWatchRef.current = () =>
      document.removeEventListener('scroll', handleScroll, { capture: true })
  }, [clearRestTimers])

  useEffect(() => {
    syncScrollWatch()
    if (!open) {
      return
    }
    openCardCount += 1
    return () => {
      openCardCount -= 1
      // A scroll-dismissed card shouldn't make the next row open on a short rest.
      if (closedByScrollRef.current) {
        closedByScrollRef.current = false
      } else {
        lastCardClosedAt = window.performance.now()
      }
    }
  }, [open, syncScrollWatch])

  useEffect(
    () => () => {
      clearRestTimers()
      detachScrollWatchRef.current?.()
      detachScrollWatchRef.current = null
    },
    [clearRestTimers]
  )

  const openFromRest = useCallback(() => {
    restTimersRef.current = null
    setResting(false)
    latestRef.current.onOpenChange(true)
  }, [])

  const onPointerEnter = useCallback((event: React.PointerEvent<HTMLElement>) => {
    triggerRef.current = event.currentTarget
    // Blocks Radix's open-on-enter. While open, let it through so returning from the card cancels its close.
    if (!latestRef.current.open) {
      event.preventDefault()
    }
  }, [])

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType === 'touch' || !recordPointerMove(event.clientX, event.clientY)) {
        return
      }
      triggerRef.current = event.currentTarget
      if (latestRef.current.open) {
        return
      }
      clearRestTimers()
      setResting(false)
      const warm = openCardCount > 0 || window.performance.now() - lastCardClosedAt < WARM_WINDOW_MS
      restTimersRef.current = warm
        ? {
            progress: undefined,
            open: window.setTimeout(openFromRest, ACTIVITY_HOVER_CARD_WARM_REST_MS)
          }
        : {
            progress: window.setTimeout(
              () => setResting(true),
              ACTIVITY_HOVER_CARD_PROGRESS_DELAY_MS
            ),
            open: window.setTimeout(openFromRest, ACTIVITY_HOVER_CARD_REST_MS)
          }
      syncScrollWatch()
    },
    [clearRestTimers, openFromRest, syncScrollWatch]
  )

  // Leaving or clicking the row means the user isn't waiting to peek it.
  const onPointerLeave = useCallback(() => {
    cancelRest()
    syncScrollWatch()
  }, [cancelRest, syncScrollWatch])

  const onFocus = useCallback((event: React.FocusEvent<HTMLElement>) => {
    triggerRef.current = event.currentTarget
    // Clicking the row's title focuses it too; only keyboard focus should open the card.
    if (!isKeyboardFocus(event.target)) {
      event.preventDefault()
    }
  }, [])

  return {
    resting,
    triggerHandlers: {
      onPointerEnter,
      onPointerMove,
      onPointerLeave,
      onPointerDown: onPointerLeave,
      onFocus
    }
  }
}
