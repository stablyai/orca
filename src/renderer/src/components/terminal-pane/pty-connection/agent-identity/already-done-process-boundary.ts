import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalAgent } from '../../../../../../shared/agent-status/identity/terminal-agent'
import { resolveCompatibleAgentTypeForOwner } from '../../../../../../shared/agent-status/title/agent-title-owner'

/** A process boundary is not a new turn when this pane's row already finished as that agent. */
export function shouldSuppressAlreadyDoneAgentProcessBoundary(
  currentStatus: Pick<AgentStatusEntry, 'state' | 'agentType'> | undefined,
  boundaryAgent: TerminalAgent
): boolean {
  if (currentStatus?.state !== 'done') {
    return false
  }
  return (
    resolveCompatibleAgentTypeForOwner(currentStatus.agentType, boundaryAgent) === boundaryAgent
  )
}
