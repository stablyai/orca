import type { AgentType } from '../agent-status-types'
import { formatAgentTypeLabel } from '../agent-type-label'

/** Use the shared name table so unknown agents retain their own name instead of becoming Codex. */
export function defaultAgentChatLabel(agent: AgentType | null | undefined): string {
  return `${formatAgentTypeLabel(agent)} Chat`
}
