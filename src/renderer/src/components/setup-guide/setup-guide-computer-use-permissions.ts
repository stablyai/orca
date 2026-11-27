import { useCallback, useEffect, useState } from 'react'
import { getComputerUsePermissionSetupState } from './setup-guide-progress-readiness'

export function useSetupGuideComputerUsePermissions(enabled: boolean): {
  ready: boolean
  checked: boolean
  unavailable: boolean
} {
  const [ready, setReady] = useState(false)
  const [checked, setChecked] = useState(false)
  const [unavailable, setUnavailable] = useState(false)

  const readPermissions = useCallback(async (isStale: () => boolean): Promise<void> => {
    const status = await window.api.computerUsePermissions.getStatus().catch(() => null)
    if (isStale()) {
      return
    }
    const permissionState = getComputerUsePermissionSetupState(status)
    setChecked(true)
    setReady(permissionState.ready)
    setUnavailable(permissionState.unavailable)
  }, [])

  useEffect(() => {
    if (!enabled) {
      // Unavailable steps must clear stale permission state before readiness is derived.
      setChecked(false)
      setReady(false)
      setUnavailable(false)
      return
    }
    let stale = false
    const refresh = (): void => {
      void readPermissions(() => stale)
    }
    refresh()
    const handleFocus = (): void => {
      void refresh()
    }
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void refresh()
      }
    }
    // Users grant OS permissions elsewhere; refresh on return without remounting.
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      stale = true
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [enabled, readPermissions])

  return { ready, checked, unavailable }
}
