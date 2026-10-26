import { useCallback, useEffect, useRef, useState } from 'react'

export function useCopyFeedbackState<T>(resetValue: T): [T, (value: T) => void] {
  const [value, setValue] = useState(resetValue)
  const resetTimerRef = useRef<number | null>(null)
  const mountedRef = useRef(true)

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current)
      resetTimerRef.current = null
    }
  }, [])

  // Clean up event-owned timers on unmount so delayed feedback cannot update a destroyed component.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearResetTimer()
    }
  }, [clearResetTimer])

  const showFeedback = useCallback(
    (nextValue: T) => {
      if (!mountedRef.current) {
        return
      }
      clearResetTimer()
      setValue(nextValue)
      resetTimerRef.current = window.setTimeout(() => {
        if (!mountedRef.current) {
          return
        }
        setValue(resetValue)
        resetTimerRef.current = null
      }, 1500)
    },
    [clearResetTimer, resetValue]
  )

  return [value, showFeedback]
}
