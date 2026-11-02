import type { AgentHookEventPayload } from './listener-event'
import { isRecord } from '../agent-status-child-work-value-guards'
import { isAskUserQuestionTool } from '../agent-question-answered-intent'

/** One Claude tool request the execution host saw end, keyed exactly as a permission wait is. */
export type ClaudeSettledRequest = {
  toolUseId: string
  toolAgentId?: string
  toolAgentType?: string
}

// Why a small bound: only requests that ended while a receiver was away matter, and each replay carries the list.
export const MAX_CLAUDE_SETTLED_REQUESTS = 16
const MAX_ID_LENGTH = 256

/** A trimmed, bounded tool-use or agent id, or undefined when the value cannot be one. */
export function readClaudeSettledId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= MAX_ID_LENGTH ? trimmed : undefined
}

/** Validates the optional wire field; anything malformed is dropped whole, never partially trusted. */
export function readClaudeSettledRequests(
  value: unknown,
  max = MAX_CLAUDE_SETTLED_REQUESTS
): ClaudeSettledRequest[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    return undefined
  }
  const requests: ClaudeSettledRequest[] = []
  for (const row of value) {
    if (!isRecord(row)) {
      return undefined
    }
    const toolUseId = readClaudeSettledId(row.toolUseId)
    const toolAgentId =
      row.toolAgentId === undefined ? undefined : readClaudeSettledId(row.toolAgentId)
    const toolAgentType =
      row.toolAgentType === undefined ? undefined : readClaudeSettledId(row.toolAgentType)
    if (
      !toolUseId ||
      (row.toolAgentId !== undefined && !toolAgentId) ||
      (row.toolAgentType !== undefined && !toolAgentType)
    ) {
      return undefined
    }
    requests.push({
      toolUseId,
      ...(toolAgentId ? { toolAgentId } : {}),
      ...(toolAgentType ? { toolAgentType } : {})
    })
  }
  return requests
}

function settledRequestOf(event: AgentHookEventPayload): ClaudeSettledRequest | undefined {
  if (
    event.payload.agentType !== 'claude' ||
    (event.hookEventName !== 'PostToolUse' && event.hookEventName !== 'PostToolUseFailure')
  ) {
    return undefined
  }
  const toolUseId = readClaudeSettledId(event.toolUseId)
  if (!toolUseId) {
    return undefined
  }
  const toolAgentId = readClaudeSettledId(event.toolAgentId)
  const toolAgentType = readClaudeSettledId(event.toolAgentType)
  return {
    toolUseId,
    ...(toolAgentId ? { toolAgentId } : {}),
    ...(toolAgentType ? { toolAgentType } : {})
  }
}

/** Batch settlements a relay forwarded, kept apart from tool settlements so they never prove an unbound wait. */
export function retainClaudeBatchSettledRequests(
  retained: readonly ClaudeSettledRequest[] | undefined,
  previous: AgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): readonly ClaudeSettledRequest[] | undefined {
  const kept = previous && sameClaudeRun(previous, next) ? (retained ?? []) : []
  // A live batch lists only ids; its owner is the batch's own. Only its last entries can survive the ring.
  const incoming = (next.claudeBatchSettledRequests ?? [])
    .slice(-MAX_CLAUDE_SETTLED_REQUESTS)
    .map((request) => ({
      toolUseId: request.toolUseId,
      ...(next.toolAgentId ? { toolAgentId: next.toolAgentId } : {}),
      ...(next.toolAgentType ? { toolAgentType: next.toolAgentType } : {})
    }))
  const merged = [
    ...kept.filter((request) => !incoming.some((added) => sameRequest(request, added))),
    ...incoming
  ].slice(-MAX_CLAUDE_SETTLED_REQUESTS)
  return merged.length > 0 ? merged : undefined
}

/** A relay's cached request that a batch from the same owner and run settles: its outcome replaces it. */
export function isClaudeCachedRequestSettledByBatch(
  cached: AgentHookEventPayload | undefined,
  batch: AgentHookEventPayload
): boolean {
  const toolUseId = readClaudeSettledId(cached?.toolUseId)
  return (
    !!cached &&
    !!toolUseId &&
    cached.payload.agentType === 'claude' &&
    cached.payload.state === 'waiting' &&
    cached.hookEventName === 'PermissionRequest' &&
    !isAskUserQuestionTool(cached.payload.toolName) &&
    cached.toolAgentId === batch.toolAgentId &&
    sameClaudeRun(cached, batch) &&
    batch.claudeBatchSettledRequests?.some((request) => request.toolUseId === toolUseId) === true
  )
}

function sameClaudeRun(previous: AgentHookEventPayload, next: AgentHookEventPayload): boolean {
  return (
    previous.launchToken === next.launchToken &&
    previous.providerSession?.id === next.providerSession?.id &&
    !next.agentPresence?.ended
  )
}

/** Carry settled request IDs beside the latest row so reconnects release overwritten permission waits. Evidence stays within one launch/session. */
export function retainClaudeSettledRequests(
  retained: readonly ClaudeSettledRequest[] | undefined,
  previous: AgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): readonly ClaudeSettledRequest[] | undefined {
  if (next.payload.agentType !== 'claude') {
    return undefined
  }
  const kept = previous && sameClaudeRun(previous, next) ? [...(retained ?? [])] : []
  const settled = settledRequestOf(next)
  if (settled) {
    const existing = kept.findIndex((request) => sameRequest(request, settled))
    if (existing !== -1) {
      kept.splice(existing, 1)
    }
    kept.push(settled)
  }
  return kept.length > 0 ? kept.slice(-MAX_CLAUDE_SETTLED_REQUESTS) : undefined
}

function sameRequest(a: ClaudeSettledRequest, b: ClaudeSettledRequest): boolean {
  return (
    a.toolUseId === b.toolUseId &&
    a.toolAgentId === b.toolAgentId &&
    a.toolAgentType === b.toolAgentType
  )
}

/** Replay settlement must come from the waiting row's own connection, launch and session. */
export function isSameClaudeReplayRun(
  waiting: Pick<AgentHookEventPayload, 'connectionId' | 'launchToken' | 'providerSession'>,
  next: Pick<AgentHookEventPayload, 'connectionId' | 'launchToken' | 'providerSession'>
): boolean {
  return (
    waiting.connectionId === next.connectionId &&
    (waiting.launchToken === undefined || waiting.launchToken === next.launchToken) &&
    (waiting.providerSession?.id === undefined ||
      waiting.providerSession.id === next.providerSession?.id)
  )
}

/** A replayed row whose host saw this exact request end: the held wait is over, whatever came after. */
export function isClaudePermissionSettledByReplay(
  waiting: AgentHookEventPayload,
  next: AgentHookEventPayload
): boolean {
  const toolUseId = readClaudeSettledId(waiting.toolUseId)
  if (
    next.isReplay !== true ||
    !toolUseId ||
    !next.claudeSettledRequests ||
    !isSameClaudeReplayRun(waiting, next)
  ) {
    return false
  }
  const toolAgentId = readClaudeSettledId(waiting.toolAgentId)
  const toolAgentType = readClaudeSettledId(waiting.toolAgentType)
  return next.claudeSettledRequests.some((request) =>
    sameRequest(request, {
      toolUseId,
      ...(toolAgentId ? { toolAgentId } : {}),
      ...(toolAgentType ? { toolAgentType } : {})
    })
  )
}
