import type { AgentHookSource } from '../agent-hook-relay'
import type { AgentHookEventPayload } from './listener-event'
import { parseHookBodyPayloadRecord } from './grok-result-discovery'

export function hasPendingClaudeUsageLimit(
  source: AgentHookSource,
  body: unknown,
  event: AgentHookEventPayload
): boolean {
  return (
    canRefineClaudeUsageLimit(source, event) &&
    parseHookBodyPayloadRecord(body)?.error === 'rate_limit'
  )
}

export function canRefineClaudeUsageLimit(
  source: AgentHookSource,
  event: AgentHookEventPayload
): boolean {
  return (
    source === 'claude' &&
    event.hookEventName === 'StopFailure' &&
    !event.toolAgentId &&
    event.providerPromptId !== undefined &&
    event.payload.mainAgent?.state === 'done' &&
    event.payload.mainAgent.outcome === 'failure' &&
    event.payload.mainAgent.usageLimit === undefined
  )
}

/** Child events retain the pending root; the bounded callback verifies its captured identity. */
export function shouldClearAssistantMessageRetry(event: AgentHookEventPayload): boolean {
  const pendingRoot =
    event.payload.agentType === 'claude' &&
    event.payload.sessionBoundary !== true &&
    event.payload.mainAgent?.state === 'done' &&
    event.payload.mainAgent.outcome === 'failure' &&
    event.payload.mainAgent.usageLimit === undefined
  return (
    !pendingRoot && (event.payload.state !== 'done' || Boolean(event.payload.lastAssistantMessage))
  )
}

export function isSameClaudeUsageLimitTurn(
  original: AgentHookEventPayload,
  current: AgentHookEventPayload
): boolean {
  return (
    current === original ||
    (original.hostTurn !== undefined &&
      current.hostTurn?.owner === original.hostTurn.owner &&
      current.hostTurn.currentTurnKey === original.hostTurn.currentTurnKey &&
      current.providerPromptId === original.providerPromptId &&
      current.providerSession?.id === original.providerSession?.id &&
      current.turnEndedAt === original.turnEndedAt &&
      current.hostTurn.completed?.turnKey === original.hostTurn.completed?.turnKey &&
      current.hostTurn.completed?.endedAt === original.hostTurn.completed?.endedAt &&
      current.launchToken === original.launchToken &&
      current.payload.sessionBoundary !== true &&
      current.payload.mainAgent?.outcome === 'failure' &&
      current.agentPresence?.process?.pid === original.agentPresence?.process?.pid &&
      current.agentPresence?.process?.platform === original.agentPresence?.process?.platform &&
      current.agentPresence?.process?.startTime === original.agentPresence?.process?.startTime)
  )
}
