import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { AutomationListBotFilter } from '@/store/slices/ui/automations-page-location'

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

/**
 * A bot's "All N automations": the list filtered to that bot. The request lives only for this visit:
 * leaving before the page applies it, or opening the page any other way, drops it.
 */
export function openBotAutomations(bot: AutomationListBotFilter): void {
  const state = useAppStore.getState()
  // The latest destination wins over a deep link still waiting for its host.
  state.setPendingAutomationRunNavigation(null)
  state.openAutomationsPage()
  state.setAutomationsPageBotFilterRequest(bot)
  const request = useAppStore.getState().automationsPageBotFilterRequest
  const stop = useAppStore.subscribe((next) => {
    if (next.automationsPageBotFilterRequest !== request) {
      stop()
    } else if (next.activeView !== 'automations') {
      stop()
      next.setAutomationsPageBotFilterRequest(null)
    }
  })
}
