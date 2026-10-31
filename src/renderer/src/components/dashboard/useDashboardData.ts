import type { AgentStatusEntry, AgentType } from '../../../../shared/agent-status-types'
import type { AgentRowState } from '../../../../shared/agent-row-decay-state'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { AgentChildRowModel } from '../../../../shared/agent-child-row-model'

export type DashboardAgentRow = {
  /** Synthetic subagent keys identify rows only; they have no PTY and must never be parsed as pane keys. */
  paneKey: string
  entry: AgentStatusEntry
  tab: TerminalTab
  agentType: AgentType
  rowSource?: 'live' | 'retained' | 'subagent'
  state: AgentRowState
  /** Focus the parent pane for subagent rows, which have no pane of their own. */
  activationPaneKey?: string
  /** Sort by oldest stateHistory start, falling back to updatedAt when no history exists. */
  startedAt: number
  /** Subagent rows only: what the row shows, decided once for every surface. */
  childRow?: AgentChildRowModel
  lineage?: {
    depth: 0 | 1
    parentPaneKey?: string
    isFirstSibling: boolean
    isLastSibling: boolean
    childCount: number
  }
}
