import { useCallback } from 'react'

type TimerRef = { current: number | null }

export function clearTimerRef(timerRef: TimerRef): void {
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }
}

/** A form ref callback that clears the address bar's close timers when the form unmounts. */
export function useClearTimersOnFormUnmount(
  blurCloseTimerRef: TimerRef,
  closingResetTimerRef: TimerRef
): (node: HTMLFormElement | null) => void {
  const clearAddressBarTimers = useCallback((): void => {
    clearTimerRef(blurCloseTimerRef)
    clearTimerRef(closingResetTimerRef)
  }, [blurCloseTimerRef, closingResetTimerRef])

  return useCallback(
    (node: HTMLFormElement | null) => {
      if (node === null) {
        clearAddressBarTimers()
      }
    },
    [clearAddressBarTimers]
  )
}
