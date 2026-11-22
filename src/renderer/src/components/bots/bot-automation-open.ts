import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'

/** Opens an automation, or one of its runs, on the Automations page. */
export function openBotAutomation(
  automationId: string,
  runId: string | null,
  hostId?: ExecutionHostId
): void {
  const state = useAppStore.getState()
  state.setPendingAutomationRunNavigation({ automationId, runId, ...(hostId ? { hostId } : {}) })
  state.openAutomationsPage()
}
