import { useCallback, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

function savedYoloPermissions(settings: GlobalSettings | null | undefined): boolean {
  const choice = settings?.agentPermissionDefault ?? 'full-access'
  return choice === 'full-access' || choice === 'auto'
}

/** Onboarding's Yolo switch: follows saved settings as they hydrate, until the person flips it. */
export function useOnboardingYoloPermissions(settings: GlobalSettings | null | undefined) {
  const [yoloPermissions, setYoloPermissions] = useState(() => savedYoloPermissions(settings))
  const chosenRef = useRef(false)
  if (settings && !chosenRef.current) {
    const saved = savedYoloPermissions(settings)
    if (saved !== yoloPermissions) {
      setYoloPermissions(saved)
    }
  }
  const setYoloPermissionsInteractive = useCallback((enabled: boolean) => {
    chosenRef.current = true
    setYoloPermissions(enabled)
  }, [])
  return { yoloPermissions, yoloPermissionsChosen: chosenRef, setYoloPermissionsInteractive }
}
