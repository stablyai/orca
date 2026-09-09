import type { AgentType } from './agent-status-types'
import { formatAgentTypeLabel } from './agent-type-label'

/** Placeholder tab label for a structured chat that has no conversation name yet.
 *  Routed through the shared agent-name table so an agent this build does not
 *  know reads as itself rather than silently as Codex. */
export function defaultAgentChatLabel(agent: AgentType | null | undefined): string {
  return `${formatAgentTypeLabel(agent)} Chat`
}
