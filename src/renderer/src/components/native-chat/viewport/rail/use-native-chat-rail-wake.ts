import { useCallback, useRef } from 'react'
import { useNativeChatPaneLifetimeEffect } from '../../pane/ownership/native-chat-pane-lifetime'
const NATIVE_CHAT_RAIL_WAKE_MS = 300
const NATIVE_CHAT_RAIL_SUSTAIN_MS = 1500
export function useNativeChatRailWake(): {
  railRef: React.RefObject<HTMLDivElement | null>
  wake: () => void
  sustain: () => void
} {
  const railRef = useRef<HTMLDivElement | null>(null)
  const awakeRail = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sleepAt = useRef(0)
  const sustainUntil = useRef(0)

  const wake = useCallback(() => {
    const now = performance.now()
    sleepAt.current = now + NATIVE_CHAT_RAIL_WAKE_MS
    sustainUntil.current = now + NATIVE_CHAT_RAIL_SUSTAIN_MS
    const rail = railRef.current
    if (rail && !('awake' in rail.dataset)) {
      rail.dataset.awake = ''
    }
    if (rail) {
      awakeRail.current = rail
    }
    if (timer.current !== null) {
      return
    }
    const settle = (): void => {
      const remaining = sleepAt.current - performance.now()
      if (remaining > 0) {
        timer.current = setTimeout(settle, remaining)
        return
      }
      timer.current = null
      if (awakeRail.current) {
        delete awakeRail.current.dataset.awake
        awakeRail.current = null
      }
    }
    timer.current = setTimeout(settle, NATIVE_CHAT_RAIL_WAKE_MS)
  }, [])

  const sustain = useCallback(() => {
    if (timer.current === null) {
      return
    }
    const now = performance.now()
    if (now < sustainUntil.current) {
      sleepAt.current = now + NATIVE_CHAT_RAIL_WAKE_MS
    }
  }, [])

  useNativeChatPaneLifetimeEffect(
    useCallback(
      () => () => {
        if (timer.current !== null) {
          clearTimeout(timer.current)
        }
        awakeRail.current = null
      },
      []
    )
  )

  return { railRef, wake, sustain }
}

/** The transcript's scroll handler: it runs `onScroll` and keeps a woken rail awake. */
export function useNativeChatRailSustainedScroll(
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void,
  sustain: () => void
): (event: React.UIEvent<HTMLDivElement>) => void {
  return useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      onScroll(event)
      sustain()
    },
    [onScroll, sustain]
  )
}
