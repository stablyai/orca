import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../shared/types'
import { getAgentRowPrimaryText } from './agent-row-primary-text'

/** The parts of an agent row that decide how it is named. Structural so this
 *  module stays independent of the dashboard row type. */
export type AgentRowNameInputs = {
  entry: Pick<AgentStatusEntry, 'orchestration' | 'prompt'>
  tab: Pick<TerminalTab, 'id'>
  lineage?: { depth: 0 | 1 }
  rowSource?: 'live' | 'retained' | 'subagent'
}

/** Why: a synthetic child row, or a depth-1 child rendered on its parent's tab,
 *  is not the thing that tab is named after. */
export function agentRowOwnsTabName(row: AgentRowNameInputs): boolean {
  if (row.rowSource === 'subagent') {
    return false
  }
  const parentPaneKey = row.entry.orchestration?.parentPaneKey
  return !(
    row.lineage?.depth === 1 &&
    parentPaneKey !== undefined &&
    parsePaneKey(parentPaneKey)?.tabId === row.tab.id
  )
}

/** The row's name: its tab's conversation name, else what the agent is working
 *  on. Empty when neither exists — callers supply their own last resort. */
export function agentRowPrimaryLabel(
  row: Pick<AgentRowNameInputs, 'entry'>,
  conversationName: string | null
): string {
  return conversationName ?? getAgentRowPrimaryText(row.entry)
}
