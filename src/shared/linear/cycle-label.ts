import type { LinearIssueSummary } from './agent-result-types'

// Why: cycles usually carry a number and no name; Linear's UI leads with the number.
export function linearCycleLabel(cycle: LinearIssueSummary['cycle']): string {
  if (!cycle) {
    return 'none'
  }
  if (cycle.number == null) {
    return cycle.name || 'none'
  }
  return cycle.name ? `${cycle.number} (${cycle.name})` : String(cycle.number)
}
