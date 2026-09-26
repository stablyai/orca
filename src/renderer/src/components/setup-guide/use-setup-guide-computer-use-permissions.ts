import { useCallback, useEffect, useState } from 'react'
import { getComputerUsePermissionSetupState } from './setup-guide-progress-readiness'

export type SetupGuideComputerUsePermissions = {
  statusChecked: boolean
  ready: boolean
  unavailable: boolean
}

export function useSetupGuideComputerUsePermissions(
  refreshEnabled: boolean,
  computerUseSkillInstalled: boolean
): SetupGuideComputerUsePermissions {
  const [permissionsReady, setPermissionsReady] = useState(false)
  const [permissionStatusChecked, setPermissionStatusChecked] = useState(false)
  const [unavailable, setUnavailable] = useState(false)

  const readComputerUsePermissions = useCallback(async (isStale: () => boolean): Promise<void> => {
    const status = await window.api.computerUsePermissions.getStatus().catch(() => null)
    if (isStale()) {
      return
    }
    const permissionState = getComputerUsePermissionSetupState(status)
    setPermissionStatusChecked(true)
    setPermissionsReady(permissionState.ready)
    setUnavailable(permissionState.unavailable)
  }, [])

  useEffect(() => {
    if (!refreshEnabled || !computerUseSkillInstalled) {
      // Why: unavailable setup-guide steps must clear stale permission state before
      // readiness is derived for the visible checklist.
      setPermissionStatusChecked(false)
      setPermissionsReady(false)
      setUnavailable(false)
      return
    }
    let stale = false
    const refreshComputerUsePermissions = (): void => {
      void readComputerUsePermissions(() => stale)
    }
    refreshComputerUsePermissions()
    const handleFocus = (): void => {
      void refreshComputerUsePermissions()
    }
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void refreshComputerUsePermissions()
      }
    }
    // Why: users grant Computer Use permissions outside the setup guide. Refresh
    // on return so the checklist updates without requiring a remount.
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      stale = true
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [computerUseSkillInstalled, readComputerUsePermissions, refreshEnabled])

  const active = refreshEnabled && computerUseSkillInstalled
  return {
    statusChecked: active && permissionStatusChecked,
    ready: active && permissionsReady,
    unavailable: active && unavailable
  }
}
