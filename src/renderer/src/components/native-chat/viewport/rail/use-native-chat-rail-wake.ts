import { useCallback, useEffect, useRef } from 'react'
const NATIVE_CHAT_RAIL_WAKE_MS = 300
const NATIVE_CHAT_RAIL_SUSTAIN_MS = 1500
export function useNativeChatRailWake(): {
  railRef: React.RefObject<HTMLDivElement | null>
  wake: () => void
  sustain: () => void
} {
  const railRef = useRef<HTMLDivElement | null>(null)
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
      if (railRef.current) {
        delete railRef.current.dataset.awake
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

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
      }
    },
    []
  )

  return { railRef, wake, sustain }
}
