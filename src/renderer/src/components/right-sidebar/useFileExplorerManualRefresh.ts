import { useCallback, useEffect, useRef, useState } from 'react'

const REFRESH_SPINNER_DELAY_MS = 200

export function useFileExplorerManualRefresh(refreshTree: () => Promise<void>): {
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
    // Why: local refreshes are usually instant, but SSH can be visibly slower.
    // Delay the spinner so fast refreshes do not flicker.
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
