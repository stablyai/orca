import { useRef, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { restoreActiveServerWorkspace } from '@/lib/active-server-workspace-selection'
import { useAppStore } from '@/store'
import { isUserManagedRuntimeEnvironment } from '../../../../shared/runtime-environments'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import { LOCAL_RUNTIME_VALUE } from '../settings/runtime-environment-selection'

export function useActiveServerSelection() {
  const settings = useAppStore((state) => state.settings)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const setActiveRuntimeEnvironmentPreference = useAppStore(
    (state) => state.setActiveRuntimeEnvironmentPreference
  )
  const setWorkspaceHostScope = useAppStore((state) => state.setWorkspaceHostScope)
  const [switching, setSwitching] = useState(false)
  const switchingRef = useRef(false)
  const mountedRef = useMountedRef()
  const activeId = settings?.activeRuntimeEnvironmentId ?? null
  const activeValue = activeId ?? LOCAL_RUNTIME_VALUE
  const localLabel = translate(
    'auto.components.settings.RuntimeEnvironmentsPane.78692becbd',
    'Local desktop'
  )
  const switchServer = async (value: string): Promise<void> => {
    if (switchingRef.current || value === activeValue) {
      return
    }
    switchingRef.current = true
    setSwitching(true)
    try {
      useAppStore.getState().seedActiveWorktreeLastVisitedIfMissing()
      if (
        await setActiveRuntimeEnvironmentPreference(value === LOCAL_RUNTIME_VALUE ? null : value)
      ) {
        const hostId =
          value === LOCAL_RUNTIME_VALUE ? LOCAL_EXECUTION_HOST_ID : toRuntimeExecutionHostId(value)
        // Why: a context switch intentionally moves both the sidebar filter and workspace creation default.
        setWorkspaceHostScope(hostId)
        restoreActiveServerWorkspace(useAppStore.getState(), hostId)
      }
    } finally {
      switchingRef.current = false
      if (mountedRef.current) {
        setSwitching(false)
      }
    }
  }

  return {
    enabled:
      Boolean(settings) &&
      runtimeEnvironments.some(isUserManagedRuntimeEnvironment) &&
      !isPairedWebClientWindow(),
    activeValue,
    localLabel,
    switching,
    switchServer
  }
}
