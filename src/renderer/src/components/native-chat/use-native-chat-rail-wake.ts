import { useCallback, useEffect, useRef } from 'react'

/** How long the rail stays lit after the last scroll input, before its CSS fade begins. */
const NATIVE_CHAT_RAIL_WAKE_MS = 300
/** Scroll events extend a wake this long after the input, so app-driven scrolls never keep it lit. */
const NATIVE_CHAT_RAIL_SUSTAIN_MS = 1500

/**
 * Lights the idle-dimmed message rail while the reader scrolls. Writes a data attribute on the
 * rail's node instead of state, so scrolling never re-renders the transcript.
 */
export function useNativeChatRailWake(): {
  railRef: React.RefObject<HTMLDivElement | null>
  wake: () => void
  /** A scroll event: keeps a just-lit rail lit through scrollbar drags and touch flings. */
  sustain: () => void
} {
  const railRef = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastWake = useRef(0)
  const lastInput = useRef(0)

  const wake = useCallback(() => {
    lastWake.current = performance.now()
    lastInput.current = lastWake.current
    const rail = railRef.current
    // Why: a gesture fires wheel events every frame; write the DOM and arm a timer once per gesture.
    if (rail && !('awake' in rail.dataset)) {
      rail.dataset.awake = ''
    }
    if (timer.current !== null) {
      return
    }
    const settle = (): void => {
      const remaining = lastWake.current + NATIVE_CHAT_RAIL_WAKE_MS - performance.now()
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
    const now = performance.now()
    if (timer.current !== null && now - lastInput.current < NATIVE_CHAT_RAIL_SUSTAIN_MS) {
      lastWake.current = now
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
