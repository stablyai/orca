import {
  pickHostTurnEnd,
  type AgentStatusEntry
} from '../../../../../shared/agent-status/contracts/agent-status-types'
import { sameAgentStatusSessionOwner } from '../../../../../shared/agent-status/identity/agent-status-terminal-owner'
import type {
  AgentStatusMetadata,
  AgentStatusRouting,
  AgentStatusPayload,
  AgentStatusTiming
} from './agent-status-contract'

function previousLiveTurnContext(
  existing: AgentStatusEntry | undefined,
  agentType: AgentStatusEntry['agentType'],
  routing: AgentStatusRouting | undefined,
  metadata: AgentStatusMetadata | undefined
): AgentStatusEntry | undefined {
  if (!existing || agentType !== 'codex') {
    return existing
  }
  return existing.agentType !== 'codex' ||
    !sameAgentStatusSessionOwner(
      {
        connectionId: existing.connectionId ?? null,
        worktreeId: existing.worktreeId,
        providerSession: existing.providerSession
      },
      {
        connectionId:
          (routing?.connectionId === undefined ? existing.connectionId : routing.connectionId) ??
          null,
        worktreeId: routing?.worktreeId ?? existing.worktreeId,
        providerSession: metadata?.providerSession
      }
    )
    ? undefined
    : existing
}

export function resolveAgentStatusLiveEntryTiming(
  existing: AgentStatusEntry | undefined,
  agentType: AgentStatusEntry['agentType'],
  {
    payload,
    timing,
    routing,
    metadata,
    updatedAt
  }: {
    payload: AgentStatusPayload
    timing?: AgentStatusTiming
    routing?: AgentStatusRouting
    metadata?: AgentStatusMetadata
    updatedAt: number
  },
  commandCodeNewTurn: boolean
) {
  const previousTurn = previousLiveTurnContext(existing, agentType, routing, metadata)
  const stateStartedAt =
    timing?.stateStartedAt ??
    (commandCodeNewTurn
      ? updatedAt
      : previousTurn && previousTurn.state === payload.state
        ? previousTurn.stateStartedAt
        : updatedAt)
  const turnStartedAt =
    timing?.turnStartedAt ??
    (previousTurn && previousTurn.state === payload.state ? previousTurn.turnStartedAt : undefined)
  const turnEnd =
    timing?.turnEndedAt !== undefined || timing?.turnEndDisposition !== undefined
      ? pickHostTurnEnd(timing)
      : previousTurn && previousTurn.state === payload.state
        ? pickHostTurnEnd(previousTurn)
        : {}
  return { stateStartedAt, turnStartedAt, turnEnd }
}
