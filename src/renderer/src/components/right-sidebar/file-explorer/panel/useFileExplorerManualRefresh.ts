import { useCallback, useEffect, useRef, useState } from 'react'

const REFRESH_SPINNER_DELAY_MS = 200

export function useFileExplorerManualRefresh(refreshTree: () => Promise<unknown>): {
  isRefreshing: boolean
  showRefreshSpinner: boolean
  handleRefresh: () => void
} {
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [showRefreshSpinner, setShowRefreshSpinner] = useState(false)
  const isRefreshingRef = useRef(false)
  const spinnerTimerRef = useRef<number | null>(null)
  const mountedRef = useRef(true)

  const clearSpinnerTimer = useCallback(() => {
    if (spinnerTimerRef.current !== null) {
      window.clearTimeout(spinnerTimerRef.current)
      spinnerTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearSpinnerTimer()
    }
  }, [clearSpinnerTimer])

  const handleRefresh = useCallback(() => {
    if (isRefreshingRef.current) {
      return
    }

    isRefreshingRef.current = true
    setIsRefreshing(true)
    // Delay the spinner so fast local refreshes do not flicker while slow SSH refreshes remain visible.
    spinnerTimerRef.current = window.setTimeout(
      () => setShowRefreshSpinner(true),
      REFRESH_SPINNER_DELAY_MS
    )
    void refreshTree().finally(() => {
      clearSpinnerTimer()
      isRefreshingRef.current = false
      if (!mountedRef.current) {
        return
      }
      setShowRefreshSpinner(false)
      setIsRefreshing(false)
    })
  }, [clearSpinnerTimer, refreshTree])

  return { isRefreshing, showRefreshSpinner, handleRefresh }
}
