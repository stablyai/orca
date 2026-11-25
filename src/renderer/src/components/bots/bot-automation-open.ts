import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'

/** Opens an automation, or one of its runs, on the Automations page of the host that has it. */
export function openBotAutomation(
  hostId: ExecutionHostId,
  automationId: string,
  runId: string | null
): void {
  const state = useAppStore.getState()
  state.setPendingAutomationRunNavigation({ automationId, runId, hostId })
  state.openAutomationsPage()
}
