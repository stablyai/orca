// Shared row wording keeps name/state fallbacks and lead/detail order consistent across surfaces.

import type { AgentChildRowModel } from './agent-child-row-model'
import type { AgentChildDisplayState } from './agent-status-child-work-display'

/** The row's name, or its state's words when the child reported none. */
export function agentChildRowName(
  row: Pick<AgentChildRowModel, 'name' | 'displayState'>,
  stateLabel: (state: AgentChildDisplayState) => string
): string {
  return row.name.trim() || stateLabel(row.displayState)
}

export function agentChildRowLeadTrail(
  row: Pick<AgentChildRowModel, 'displayState'>,
  name: string,
  detail: string
): { lead: string; trail: string } {
  // Lead with monitoring state so truncation still distinguishes passive work.
  if (row.displayState === 'monitoring' && detail) {
    return { lead: detail, trail: detail === name ? '' : name }
  }
  return { lead: name, trail: detail }
}
