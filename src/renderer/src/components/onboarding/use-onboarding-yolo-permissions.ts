import { useCallback, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { resolveAgentPermissionModeSummary } from '../../../../shared/tui-agent-permissions'

function savedYoloPermissions(settings: GlobalSettings | null | undefined): boolean {
  return (
    resolveAgentPermissionModeSummary({
      agentDefaultArgs: settings?.agentDefaultArgs,
      agentDefaultEnv: settings?.agentDefaultEnv
    }) !== 'manual'
  )
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
