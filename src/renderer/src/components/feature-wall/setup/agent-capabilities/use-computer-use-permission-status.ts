import { useEffect, useState } from 'react'

export type ComputerUsePermissionSetupStatus = {
  ready: boolean
  checking: boolean
  unavailableReason: string | null
}

export function useComputerUsePermissionStatus(enabled: boolean): ComputerUsePermissionSetupStatus {
  const [status, setStatus] = useState<ComputerUsePermissionSetupStatus>({
    ready: false,
    checking: enabled,
    unavailableReason: null
  })

  useEffect(() => {
    if (!enabled) {
      setStatus({ ready: false, checking: false, unavailableReason: null })
      return
    }

    let stale = false
    const refresh = (): void => {
      setStatus((current) => ({ ...current, checking: true }))
      window.api.computerUsePermissions
        .getStatus()
        .then((next) => {
          if (stale) {
            return
          }
          setStatus({
            ready:
              next.helperUnavailableReason === null &&
              next.permissions.every((permission) => permission.status !== 'not-granted'),
            checking: false,
            unavailableReason: next.helperUnavailableReason
          })
        })
        .catch(() => {
          if (stale) {
            return
          }
          setStatus({ ready: false, checking: false, unavailableReason: null })
        })
    }

    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      stale = true
      window.removeEventListener('focus', refresh)
    }
  }, [enabled])

  return status
}
