import type { TaskSourceHostAvailability } from '../task-source-context-summary'
import type { AutomationListRow } from './automation-list-row-identity'
import { useAutomationSourceHostAvailability } from './use-automation-source-host-availability'

/** Keeps source-host probing behind the page controller's small state contract. */
export function useAutomationSourceAvailability(rows: readonly AutomationListRow[]) {
  const automationSourceHostAvailabilityByRowKey = useAutomationSourceHostAvailability(rows)
  return { automationSourceHostAvailabilityByRowKey }
}

export type AutomationSourceAvailability = {
  automationSourceHostAvailabilityByRowKey: ReadonlyMap<string, TaskSourceHostAvailability[]>
}
