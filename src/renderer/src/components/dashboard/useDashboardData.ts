import type {
  AgentStatusEntry,
  AgentStatusState,
  AgentType
} from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

export type DashboardAgentRow = {
  /** Row identity. For 'subagent' rows this is a synthetic key (the child has
   *  no PTY) — unique for React/lineage maps but never parsed as a pane key. */
  paneKey: string
  entry: AgentStatusEntry
  tab: TerminalTab
  agentType: AgentType
  rowSource?: 'live' | 'retained' | 'subagent'
  state: AgentStatusState | 'idle'
  /** Pane to focus when the row is activated, when it differs from paneKey.
   *  Subagent rows use this as the parent-terminal fallback. */
  activationPaneKey?: string
  /** Explicit provider session identity for an in-process child. The child has
   *  no PTY, so consumers must not derive this from the synthetic pane key. */
  subagentSession?: {
    id: string
    provider: AgentType
    parentPaneKey: string
  }
  /** When this agent first began reporting status. Derived from the oldest
   *  stateHistory entry, falling back to updatedAt when no history exists yet.
   *  Used to sort agents by when they started. */
  startedAt: number
  lineage?: {
    depth: 0 | 1
    parentPaneKey?: string
    isFirstSibling: boolean
    isLastSibling: boolean
    childCount: number
  }
}
