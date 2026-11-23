import { useAppStore } from '@/store'

/** Opens an automation, or one of its runs, on the Automations page. */
export function openBotAutomation(automationId: string, runId: string | null): void {
  const state = useAppStore.getState()
  state.setPendingAutomationRunNavigation({ automationId, runId })
  state.openAutomationsPage()
}
