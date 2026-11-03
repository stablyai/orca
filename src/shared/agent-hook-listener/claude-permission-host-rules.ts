import { isAskUserQuestionTool } from '../agent-question-answered-intent'
import type { AgentHookEventPayload } from './listener-event'
import type { HookListenerState } from './listener-state'
import { buildClaudeCachedLeadStatusPayload } from './providers/claude-lifecycle-events'
import { setClaudeMainAgentTurnState } from './providers/claude-roster-state'
import {
  isClaudePermissionOwningChildEnding,
  withHeldChildWaitMainAgent
} from './claude-permission-transition'

// Host-only rules: an execution host deciding for its own observations; never applied to unprojected remote rows.

/** An admitted root session start: a new conversation, or this one in a new process. Compact never gets here. */
export function replacesSession(next: AgentHookEventPayload): boolean {
  return (
    next.agentPresence?.ended === true ||
    (!next.toolAgentId &&
      next.hookEventName === 'SessionStart' &&
      next.payload.sessionBoundary === true)
  )
}

function isOrdinaryClaudeRequest(row: AgentHookEventPayload): boolean {
  return (
    row.payload.agentType === 'claude' &&
    row.payload.state === 'waiting' &&
    row.hookEventName === 'PermissionRequest' &&
    !isAskUserQuestionTool(row.payload.toolName)
  )
}

/**
 * A waiting row that opens no dialog of its own (a lifecycle, timer or inventory publication of the
 * cached lead) still shows the represented request; only a real request, question or elicitation replaces it.
 */
export function restatesRequest(
  previous: AgentHookEventPayload,
  next: AgentHookEventPayload
): boolean {
  const opensDialog =
    next.hookEventName === 'PermissionRequest' ||
    next.hookEventName === 'Elicitation' ||
    (next.hookEventName === 'PreToolUse' && isAskUserQuestionTool(next.payload.toolName))
  return (
    isOrdinaryClaudeRequest(previous) &&
    next.payload.agentType === 'claude' &&
    next.payload.state === 'waiting' &&
    !opensDialog &&
    next.hasExplicitPrompt !== true &&
    !isClaudePermissionOwningChildEnding(previous, next)
  )
}

/** Hold the request; refresh the live roster around it, so a held request never archives ended children. */
export function holdClaudeRequest<T extends AgentHookEventPayload>(
  previous: T,
  next: AgentHookEventPayload,
  refreshRoster: boolean
): T {
  const held = withHeldChildWaitMainAgent(previous, next)
  const roster = next.payload.subagents
  if (!refreshRoster || JSON.stringify(held.payload.subagents) === JSON.stringify(roster)) {
    return held
  }
  return { ...held, payload: { ...held.payload, subagents: roster } }
}

/** A parent's turn end is not its child's: a live child's request stays until its own end. */
export function childRequestOutlivesParentEnd(
  host: HookListenerState,
  previous: AgentHookEventPayload,
  next: AgentHookEventPayload
): boolean {
  const owner = previous.toolAgentId?.trim()
  return (
    !!owner &&
    !next.toolAgentId &&
    isOrdinaryClaudeRequest(previous) &&
    next.payload.agentType === 'claude' &&
    next.payload.state === 'done' &&
    next.hasExplicitPrompt !== true &&
    // Hook agents never join the roster; anyone else missing from it has ended.
    (owner.startsWith('hook-agent-') ||
      host.claudeSubagentRosterByPaneKey.get(previous.paneKey)?.has(owner) === true)
  )
}

/**
 * A completed batch from the request's own owner and run lists the request: by the id the provider gave it,
 * else by its whole input. A match is not an identity; no member id is ever assigned to the request.
 */
export function claudeBatchSettlesRequest(
  previous: AgentHookEventPayload | undefined,
  batch: AgentHookEventPayload
): boolean {
  const request = previous?.claudeRequest
  if (
    !previous ||
    !request ||
    !batch.claudeBatch ||
    previous.restoredUnconfirmed ||
    previous.payload.agentType !== 'claude' ||
    previous.payload.state !== 'waiting' ||
    previous.hookEventName !== 'PermissionRequest' ||
    previous.toolAgentId !== batch.toolAgentId ||
    previous.connectionId !== batch.connectionId ||
    previous.launchToken !== batch.launchToken ||
    previous.providerSession?.id !== batch.providerSession?.id
  ) {
    return false
  }
  return batch.claudeBatch.members.some((member) =>
    request.providerToolUseId
      ? member.toolUseId === request.providerToolUseId
      : request.digest !== undefined && member.digest === request.digest
  )
}

/** The batch ended the request the lead was waiting on: resume what that wait displaced, then show it. */
export function resumeClaudeRequestLead(
  state: HookListenerState,
  request: AgentHookEventPayload,
  batch: AgentHookEventPayload
): AgentHookEventPayload {
  const lead = state.claudeLeadStateByPaneKey.get(batch.paneKey)
  if (lead?.state === 'waiting' && lead.waitingAgentId === request.toolAgentId) {
    setClaudeMainAgentTurnState(
      state,
      batch.paneKey,
      lead.waitingAgentId
        ? (lead.stateBeforeWait ?? { state: 'working' })
        : { state: 'working', ...(lead.taskWakeupTurn ? { taskWakeupTurn: true as const } : {}) }
    )
  }
  const payload = buildClaudeCachedLeadStatusPayload(state, 'PostToolBatch', batch.paneKey, {})
  return payload ? { ...batch, payload } : batch
}
