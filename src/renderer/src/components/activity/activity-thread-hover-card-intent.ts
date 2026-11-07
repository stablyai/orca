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

// Scroll-induced hover events at unchanged coordinates are not intent to peek; require real pointer movement.
function recordPointerMove(x: number, y: number): boolean {
  const moved = lastPointerPosition?.x !== x || lastPointerPosition?.y !== y
  lastPointerPosition = { x, y }
  return moved
}

function isKeyboardFocus(target: EventTarget): boolean {
  return target instanceof Element && target.matches(':focus-visible')
}

function isRowControl(target: EventTarget): boolean {
  return target instanceof Element && target.closest('[data-activity-thread-control]') !== null
}

export function _resetActivityHoverCardIntentForTest(): void {
  lastPointerPosition = null
  openCardCount = 0
  lastCardClosedAt = Number.NEGATIVE_INFINITY
}

type OpenTimers = { progress: number | undefined; open: number }

// Owns opening from pointer rest and keyboard focus; Radix owns closing and card traversal.
export function useActivityThreadHoverCardIntent({
  open,
  onOpenChange,
  openDelay = 200,
  enabled = true
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  openDelay?: number
  enabled?: boolean
}) {
  const [resting, setResting] = useState(false)
  const triggerRef = useRef<HTMLElement | null>(null)
  const openTimersRef = useRef<OpenTimers | null>(null)
  const detachScrollWatchRef = useRef<(() => void) | null>(null)
  const closedByScrollRef = useRef(false)
  const latestRef = useRef({ open, onOpenChange, openDelay, enabled })
  useEffect(() => {
    latestRef.current = { open, onOpenChange, openDelay, enabled }
  })

  const clearOpenTimers = useCallback(() => {
    const timers = openTimersRef.current
    if (timers) {
      window.clearTimeout(timers.progress)
      window.clearTimeout(timers.open)
      openTimersRef.current = null
    }
  }, [])

  const cancelPendingOpen = useCallback(() => {
    clearOpenTimers()
    setResting(false)
  }, [clearOpenTimers])

  // Watch scrolls only while a rest is pending or the card is open, to stay off the hot path.
  const syncScrollWatch = useCallback(() => {
    const needed = latestRef.current.open || openTimersRef.current !== null
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
      clearOpenTimers()
      setResting(false)
      if (latestRef.current.open) {
        closedByScrollRef.current = true
        latestRef.current.onOpenChange(false)
      }
    }
    document.addEventListener('scroll', handleScroll, { capture: true, passive: true })
    detachScrollWatchRef.current = () =>
      document.removeEventListener('scroll', handleScroll, { capture: true })
  }, [clearOpenTimers])

  useEffect(() => {
    if (!enabled) {
      cancelPendingOpen()
      syncScrollWatch()
    }
  }, [enabled, cancelPendingOpen, syncScrollWatch])

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
      clearOpenTimers()
      detachScrollWatchRef.current?.()
      detachScrollWatchRef.current = null
    },
    [clearOpenTimers]
  )

  const openFromIntent = useCallback(() => {
    openTimersRef.current = null
    setResting(false)
    if (latestRef.current.enabled) {
      latestRef.current.onOpenChange(true)
    }
  }, [])

  const dismissForControl = useCallback(() => {
    cancelPendingOpen()
    if (latestRef.current.open) {
      latestRef.current.onOpenChange(false)
    }
    syncScrollWatch()
  }, [cancelPendingOpen, syncScrollWatch])

  const onRadixOpenChange = useCallback(
    (next: boolean) => {
      // Radix may cancel closing when re-entering the card, but only intent may open it.
      // A delayed close after control dismissal must preserve fresh opening intent.
      if (!next && latestRef.current.open) {
        cancelPendingOpen()
        latestRef.current.onOpenChange(false)
        syncScrollWatch()
      }
    },
    [cancelPendingOpen, syncScrollWatch]
  )

  const onPointerEnter = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      triggerRef.current = event.currentTarget
      // Blocks Radix's open-on-enter. While open, let it through so returning from the card cancels its close.
      if (!latestRef.current.open || isRowControl(event.target)) {
        event.preventDefault()
      }
      if (isRowControl(event.target)) {
        dismissForControl()
      }
    },
    [dismissForControl]
  )

  const onPointerOver = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (isRowControl(event.target)) {
        dismissForControl()
      }
    },
    [dismissForControl]
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.pointerType === 'touch') {
        return
      }
      const moved = recordPointerMove(event.clientX, event.clientY)
      if (isRowControl(event.target)) {
        dismissForControl()
        return
      }
      if (!moved || !latestRef.current.enabled) {
        return
      }
      triggerRef.current = event.currentTarget
      if (latestRef.current.open) {
        return
      }
      clearOpenTimers()
      setResting(false)
      const warm = openCardCount > 0 || window.performance.now() - lastCardClosedAt < WARM_WINDOW_MS
      openTimersRef.current = warm
        ? {
            progress: undefined,
            open: window.setTimeout(openFromIntent, ACTIVITY_HOVER_CARD_WARM_REST_MS)
          }
        : {
            progress: window.setTimeout(
              () => setResting(true),
              ACTIVITY_HOVER_CARD_PROGRESS_DELAY_MS
            ),
            open: window.setTimeout(openFromIntent, ACTIVITY_HOVER_CARD_REST_MS)
          }
      syncScrollWatch()
    },
    [clearOpenTimers, dismissForControl, openFromIntent, syncScrollWatch]
  )

  // Leaving or clicking the row means the user isn't waiting to peek it.
  const cancelIntent = useCallback(() => {
    cancelPendingOpen()
    syncScrollWatch()
  }, [cancelPendingOpen, syncScrollWatch])

  const onFocus = useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      triggerRef.current = event.currentTarget
      const keyboardFocus = isKeyboardFocus(event.target)
      const control = isRowControl(event.target)
      if (!latestRef.current.open || !keyboardFocus || control) {
        event.preventDefault()
      }
      if (control) {
        dismissForControl()
        return
      }
      if (!keyboardFocus || latestRef.current.open || !latestRef.current.enabled) {
        return
      }
      cancelPendingOpen()
      openTimersRef.current = {
        progress: undefined,
        open: window.setTimeout(openFromIntent, latestRef.current.openDelay)
      }
      syncScrollWatch()
    },
    [cancelPendingOpen, dismissForControl, openFromIntent, syncScrollWatch]
  )

  return {
    resting,
    onOpenChange: onRadixOpenChange,
    triggerHandlers: {
      onPointerEnter,
      onPointerOver,
      onPointerMove,
      onPointerLeave: cancelIntent,
      onPointerDown: cancelIntent,
      onFocus,
      onBlur: cancelIntent
    }
  }
}
