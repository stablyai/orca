import type { AgentHookEventPayload } from '../../agent-hook-listener/listener-event'
import { sameAgentStatusTerminalOwner } from '../identity/agent-status-terminal-owner'
import { agentTurnEndedOnPurpose } from './agent-main-agent-verdict'

type CompletionRow = AgentHookEventPayload & { stateStartedAt?: number }

export function readLastCompletionAt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Retain the last result independently of the current state and provider-session clocks. */
export function retainAgentLastCompletionAt(
  entry: CompletionRow,
  previous: CompletionRow | undefined
): number {
  const supplied = readLastCompletionAt(entry.lastCompletionAt)
  const prior =
    previous &&
    sameAgentStatusTerminalOwner(previous, entry) &&
    previous.payload.agentType === entry.payload.agentType
      ? previous
      : undefined
  const previousCompletion =
    prior?.lastCompletionAt ??
    (prior?.payload.state === 'done' &&
    prior.payload.sessionBoundary !== true &&
    !agentTurnEndedOnPurpose(prior.payload)
      ? (prior.stateStartedAt ?? prior.turnEndedAt ?? 0)
      : 0)
  if (
    entry.payload.state !== 'done' ||
    entry.payload.sessionBoundary === true ||
    agentTurnEndedOnPurpose(entry.payload)
  ) {
    return supplied ?? previousCompletion
  }
  if (
    prior?.payload.state === 'done' &&
    prior.payload.sessionBoundary !== true &&
    !agentTurnEndedOnPurpose(prior.payload) &&
    entry.stateStartedAt === prior.stateStartedAt &&
    entry.turnEndedAt === prior.turnEndedAt
  ) {
    return previousCompletion
  }
  return (
    entry.stateStartedAt ??
    supplied ??
    entry.turnEndedAt ??
    entry.hostEvidenceObservedAt ??
    Date.now()
  )
}
