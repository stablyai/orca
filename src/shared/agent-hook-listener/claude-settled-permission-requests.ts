import type { AgentHookEventPayload } from './listener-event'
import { isRecord } from '../agent-status-child-work-value-guards'

/** One Claude tool request the execution host saw end, keyed exactly as a permission wait is. */
export type ClaudeSettledRequest = {
  toolUseId: string
  toolAgentId?: string
  toolAgentType?: string
}

// Why a small bound: only requests that ended while a receiver was away matter, and each replay carries the list.
export const MAX_CLAUDE_SETTLED_REQUESTS = 16
const MAX_ID_LENGTH = 256

function readId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= MAX_ID_LENGTH ? trimmed : undefined
}

/** Validates the optional wire field; anything malformed is dropped whole, never partially trusted. */
export function readClaudeSettledRequests(value: unknown): ClaudeSettledRequest[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CLAUDE_SETTLED_REQUESTS) {
    return undefined
  }
  const requests: ClaudeSettledRequest[] = []
  for (const row of value) {
    if (!isRecord(row)) {
      return undefined
    }
    const toolUseId = readId(row.toolUseId)
    const toolAgentId = row.toolAgentId === undefined ? undefined : readId(row.toolAgentId)
    const toolAgentType = row.toolAgentType === undefined ? undefined : readId(row.toolAgentType)
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
  const toolUseId = readId(event.toolUseId)
  if (!toolUseId) {
    return undefined
  }
  const toolAgentId = readId(event.toolAgentId)
  const toolAgentType = readId(event.toolAgentType)
  return {
    toolUseId,
    ...(toolAgentId ? { toolAgentId } : {}),
    ...(toolAgentType ? { toolAgentType } : {})
  }
}

function sameClaudeRun(previous: AgentHookEventPayload, next: AgentHookEventPayload): boolean {
  return (
    previous.launchToken === next.launchToken &&
    previous.providerSession?.id === next.providerSession?.id &&
    !next.agentPresence?.ended
  )
}

/**
 * The relay caches one status row per pane, so a later hook overwrites the PostToolUse that ended a
 * request. Keeping the ended request ids beside that row lets a reconnecting receiver release a
 * permission wait it is still holding. Evidence never crosses into another launch or session.
 */
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

/** A replayed row whose host saw this exact request end: the held wait is over, whatever came after. */
export function isClaudePermissionSettledByReplay(
  waiting: AgentHookEventPayload,
  next: AgentHookEventPayload
): boolean {
  const toolUseId = readId(waiting.toolUseId)
  if (
    next.isReplay !== true ||
    !toolUseId ||
    !next.claudeSettledRequests ||
    waiting.connectionId !== next.connectionId ||
    (waiting.launchToken !== undefined && waiting.launchToken !== next.launchToken) ||
    (waiting.providerSession?.id !== undefined &&
      waiting.providerSession.id !== next.providerSession?.id)
  ) {
    return false
  }
  const toolAgentId = readId(waiting.toolAgentId)
  const toolAgentType = readId(waiting.toolAgentType)
  return next.claudeSettledRequests.some((request) =>
    sameRequest(request, {
      toolUseId,
      ...(toolAgentId ? { toolAgentId } : {}),
      ...(toolAgentType ? { toolAgentType } : {})
    })
  )
}
