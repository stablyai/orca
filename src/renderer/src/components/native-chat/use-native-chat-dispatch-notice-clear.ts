import { useEffect, useRef } from 'react'

/**
 * Clears a composer notice once a session-option dispatch (e.g. a picker's
 * /model command) finishes, so a "Confirming selection..." message set while
 * a blocked send fired doesn't linger after the block itself has lifted.
 */
export function useNativeChatDispatchNoticeClear(
  isDispatching: boolean,
  setNotice: (notice: string | null) => void
): void {
  const wasDispatchingRef = useRef(false)
  useEffect(() => {
    if (isDispatching) {
      wasDispatchingRef.current = true
      return
    }
    if (wasDispatchingRef.current) {
      wasDispatchingRef.current = false
      setNotice(null)
    }
  }, [isDispatching, setNotice])
}
