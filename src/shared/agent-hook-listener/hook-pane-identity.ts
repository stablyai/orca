import { resolveAgentStatusIdentity } from '../agent-status-identity'
import { sameAgentStatusTerminalOwner } from '../agent-status-terminal-owner'
import type { AgentHookSource } from '../agent-hook-relay'
import type { AgentProcessIdentity } from '../agent-process-presence'
import type { AgentHookEventPayload } from './listener-event'

export function inheritsActiveHookPaneIdentity(
  previousStatus: AgentHookEventPayload | undefined,
  source: AgentHookSource,
  worktreeId: string | undefined,
  incomingProcess: AgentProcessIdentity | undefined,
  incomingSession: string | undefined
): boolean {
  const previousReceivedAt =
    previousStatus &&
    'receivedAt' in previousStatus &&
    typeof previousStatus.receivedAt === 'number'
      ? previousStatus.receivedAt
      : previousStatus?.hostEvidenceObservedAt
  return Boolean(
    previousStatus &&
    previousReceivedAt !== undefined &&
    sameAgentStatusTerminalOwner(
      { connectionId: previousStatus.connectionId ?? null, worktreeId: previousStatus.worktreeId },
      { connectionId: null, worktreeId }
    ) &&
    resolveAgentStatusIdentity({
      existing: {
        agentType: previousStatus.payload.agentType,
        state: previousStatus.payload.state,
        updatedAt: previousReceivedAt,
        restoredUnconfirmed: previousStatus.restoredUnconfirmed,
        agentPresence: previousStatus.providerSessionOnly ? undefined : previousStatus.agentPresence
      },
      incoming: source,
      incomingProcess,
      incomingSession,
      now: Date.now()
    }).inheritedFromActivePane
  )
}
