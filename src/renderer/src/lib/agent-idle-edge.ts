import { detectAgentStatusFromTitle, isClaudeAgent } from '../../../shared/agent-detection'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { AgentIdleEdgeMeta } from '../../../shared/terminal-output-side-effects'

/** Claude owns the edge: its title says so, or its status row does once the title drops its glyph. */
export function isClaudeIdleEdge(title: string, entry: AgentStatusEntry | undefined): boolean {
  return isClaudeAgent(title) || entry?.agentType === 'claude'
}

/** The agent settled at rest, not on a prompt; the title decides only for edges from older hosts. */
export function idleEdgeSettledAtRest(title: string, meta: AgentIdleEdgeMeta | undefined): boolean {
  return (meta?.status ?? detectAgentStatusFromTitle(title)) === 'idle'
}
