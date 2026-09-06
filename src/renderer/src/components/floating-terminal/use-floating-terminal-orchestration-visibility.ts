import { useCallback, useEffect } from 'react'
import { isOrcaCliAvailableOnPath } from '@/lib/agent-skill-cli-prerequisite'
import {
  ORCHESTRATION_SETUP_STATE_EVENT,
  hasOrchestrationSetupMarker,
  isOrchestrationSetupDismissed
} from '@/lib/orchestration-setup-state'
import type { FloatingTerminalPanelLocalState } from './use-floating-terminal-panel-local-state'

type FloatingTerminalOrchestrationVisibilityInput = Pick<
  FloatingTerminalPanelLocalState,
  'mountedRef' | 'setShowOrchestrationSetup'
> & { open: boolean }

export function useFloatingTerminalOrchestrationVisibility({
  mountedRef,
  setShowOrchestrationSetup,
  open
}: FloatingTerminalOrchestrationVisibilityInput) {
  const refreshOrchestrationSetupVisibility = useCallback(async (): Promise<void> => {
    if (isOrchestrationSetupDismissed()) {
      setShowOrchestrationSetup(false)
      return
    }
    if (!hasOrchestrationSetupMarker()) {
      setShowOrchestrationSetup(true)
      return
    }
    try {
      const status = await window.api.cli.getInstallStatus()
      if (mountedRef.current) {
        setShowOrchestrationSetup(!isOrcaCliAvailableOnPath(status))
      }
    } catch {
      if (mountedRef.current) {
        setShowOrchestrationSetup(true)
      }
    }
  }, [mountedRef, setShowOrchestrationSetup])

  useEffect(() => {
    if (open) {
      void refreshOrchestrationSetupVisibility()
    }
  }, [open, refreshOrchestrationSetupVisibility])

  useEffect(() => {
    const handleSetupStateChange = (): void => {
      void refreshOrchestrationSetupVisibility()
    }
    window.addEventListener(ORCHESTRATION_SETUP_STATE_EVENT, handleSetupStateChange)
    return () => {
      window.removeEventListener(ORCHESTRATION_SETUP_STATE_EVENT, handleSetupStateChange)
    }
  }, [refreshOrchestrationSetupVisibility])

  return { refreshOrchestrationSetupVisibility }
}
