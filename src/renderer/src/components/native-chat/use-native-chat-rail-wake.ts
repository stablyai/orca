import { useCallback, useEffect, useRef } from 'react'

/** How long the rail stays lit after the last scroll input, before its CSS fade begins. */
const NATIVE_CHAT_RAIL_WAKE_MS = 300

/**
 * Lights the idle-dimmed message rail while the reader scrolls. Writes a data attribute on the
 * rail's node instead of state, so scrolling never re-renders the transcript.
 */
export function useNativeChatRailWake(): {
  railRef: React.RefObject<HTMLDivElement | null>
  wake: () => void
} {
  const railRef = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const wake = useCallback(() => {
    const rail = railRef.current
    if (!rail) {
      return
    }
    rail.dataset.awake = ''
    if (timer.current !== null) {
      clearTimeout(timer.current)
    }
    timer.current = setTimeout(() => {
      timer.current = null
      delete rail.dataset.awake
    }, NATIVE_CHAT_RAIL_WAKE_MS)
  }, [])

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
      }
    },
    []
  )

  return { railRef, wake }
}
