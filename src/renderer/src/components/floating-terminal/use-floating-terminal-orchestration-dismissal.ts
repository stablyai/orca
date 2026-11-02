import { useCallback } from 'react'
import {
  ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY,
  notifyOrchestrationSetupStateChanged
} from '@/lib/orchestration-setup-state'
import type { FloatingTerminalPanelLocalState } from './use-floating-terminal-panel-local-state'

export function useFloatingTerminalOrchestrationDismissal({
  setShowOrchestrationSetup
}: Pick<FloatingTerminalPanelLocalState, 'setShowOrchestrationSetup'>) {
  const dismissOrchestrationSetup = useCallback(() => {
    localStorage.setItem(ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY, '1')
    setShowOrchestrationSetup(false)
    notifyOrchestrationSetupStateChanged()
  }, [setShowOrchestrationSetup])

  return { dismissOrchestrationSetup }
}
