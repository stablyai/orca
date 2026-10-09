// How a child row's one line reads, for every surface that words it in its own language: the name
// (or the state when the child reported none), and which of name and detail leads.

import type { AgentChildRowModel } from './agent-child-row-model'
import type { AgentChildDisplayState } from './agent-status-child-work-display'

/** The row's name, or its state's words when the child reported none. */
export function agentChildRowName(
  row: Pick<AgentChildRowModel, 'name' | 'displayState'>,
  stateLabel: (state: AgentChildDisplayState) => string
): string {
  return row.name.trim() || stateLabel(row.displayState)
}

/** A row's one line from its name and detail words; '' trail when there is nothing more to say. */
export function agentChildRowLeadTrail(
  row: Pick<AgentChildRowModel, 'displayState'>,
  name: string,
  detail: string
): { lead: string; trail: string } {
  // Why: a monitoring row leads with its state so truncation keeps passive distinct from active.
  if (row.displayState === 'monitoring' && detail) {
    return { lead: detail, trail: detail === name ? '' : name }
  }
  return { lead: name, trail: detail }
}
