import { mainAgentStatusEqual } from '../main-agent-status'
import { claudeTeammateIdMatchesName, isClaudeChildTurnEndEvent } from '../claude-subagent-roster'
import { isAskUserQuestionTool } from '../agent-question-answered-intent'
import type { AgentHookEventPayload } from './listener-event'
import { isClaudePermissionSettledByReplay } from './claude-settled-permission-requests'
import type { HookListenerState } from './listener-state'
import {
  childRequestOutlivesParentEnd,
  claudeBatchSettlesRequest,
  replacesSession,
  restatesRequest
} from './claude-permission-host-rules'

export {
  claudeBatchSettlesRequest,
  holdClaudeRequest,
  resumeClaudeRequestLead
} from './claude-permission-host-rules'

/** Retain the shell-work fact only with the main-agent observation that established it. */
export function pairedClaudeNonAgentWork(
  previous: AgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): boolean | undefined {
  if (next.claudeRunningNonAgentTask !== undefined) {
    return next.claudeRunningNonAgentTask
  }
  return previous && mainAgentStatusEqual(previous.payload.mainAgent, next.payload.mainAgent)
    ? previous.claudeRunningNonAgentTask
    : undefined
}

/** Keep main-agent progress behind a child's permission prompt so restart cannot settle live work. */
export function withHeldChildWaitMainAgent<T extends AgentHookEventPayload>(
  previous: T,
  next: AgentHookEventPayload
): T {
  const mainAgent = next.payload.mainAgent
  if (!previous.toolAgentId || !mainAgent) {
    return previous
  }
  const runningNonAgentTask = pairedClaudeNonAgentWork(previous, next)
  const mainAgentChanged = !mainAgentStatusEqual(previous.payload.mainAgent, mainAgent)
  const pendingWakeup = next.payload.claudeTaskWakeupPending
  const wakeupChanged = pendingWakeup !== previous.payload.claudeTaskWakeupPending
  if (
    !mainAgentChanged &&
    !wakeupChanged &&
    runningNonAgentTask === previous.claudeRunningNonAgentTask
  ) {
    return previous
  }
  return {
    ...previous,
    claudeRunningNonAgentTask: runningNonAgentTask,
    payload:
      mainAgentChanged || wakeupChanged
        ? { ...previous.payload, mainAgent, claudeTaskWakeupPending: pendingWakeup }
        : previous.payload
  }
}

/**
 * `host` is the execution host deciding for its own observations (local hooks, a relay); without it this is
 * the legacy decision a receiver applies to rows from a host that publishes no projection.
 */
export function shouldKeepClaudePermissionVisible(
  previous: AgentHookEventPayload | undefined,
  next: AgentHookEventPayload,
  host?: HookListenerState
): boolean {
  if (previous?.restoredUnconfirmed) {
    return false
  }
  if (
    host &&
    previous &&
    !replacesSession(next) &&
    (childRequestOutlivesParentEnd(host, previous, next) || restatesRequest(previous, next))
  ) {
    return true
  }
  if (
    previous?.payload.agentType !== 'claude' ||
    previous.payload.state !== 'waiting' ||
    previous.hookEventName !== 'PermissionRequest' ||
    next.payload.agentType !== 'claude' ||
    next.payload.state !== 'working'
  ) {
    return false
  }
  if (next.hasExplicitPrompt === true) {
    return false
  }
  if (isClaudePermissionOwningChildEnding(previous, next)) {
    return false
  }
  if (isClaudePermissionSettledByReplay(previous, next)) {
    return false
  }
  if (host && claudeBatchSettlesRequest(previous, next)) {
    return false
  }
  if (isClaudePermissionResumingApprovedTool(previous, next)) {
    return false
  }
  // AskUserQuestion can arrive as PermissionRequest; only actual permissions stay sticky.
  if (isAskUserQuestionTool(previous.payload.toolName)) {
    return false
  }
  return true
}

export function isClaudePermissionOwningChildEnding(
  previous: AgentHookEventPayload,
  next: AgentHookEventPayload
): boolean {
  const ownerId = previous.toolAgentId?.trim()
  if (!ownerId) {
    return false
  }
  if (isClaudeChildTurnEndEvent(next.hookEventName, next.toolAgentId)) {
    return ownerId === next.toolAgentId?.trim()
  }
  return (
    next.hookEventName === 'TeammateIdle' &&
    next.teammateName !== undefined &&
    claudeTeammateIdMatchesName(ownerId, next.teammateName)
  )
}

function isClaudePermissionResumingApprovedTool(
  previous: AgentHookEventPayload,
  next: AgentHookEventPayload
): boolean {
  const previousToolUseId = previous.toolUseId?.trim() || undefined
  const nextToolUseId = next.toolUseId?.trim() || undefined
  const previousAgentId = previous.toolAgentId?.trim() || undefined
  const nextAgentId = next.toolAgentId?.trim() || undefined
  const hasAgentId = previousAgentId !== undefined || nextAgentId !== undefined
  const previousAgentType = previous.toolAgentType?.trim() || undefined
  const nextAgentType = next.toolAgentType?.trim() || undefined
  const hasMatchingConcreteAgentId =
    previousAgentId !== undefined && previousAgentId === nextAgentId
  const hasSameExplicitAgentType =
    !hasAgentId && previousAgentType !== undefined && previousAgentType === nextAgentType
  const sameToolName =
    previous.payload.toolName !== undefined && previous.payload.toolName === next.payload.toolName
  const sameKnownToolInput =
    previous.payload.toolInput !== undefined &&
    previous.payload.toolInput === next.payload.toolInput
  const sameUnknownInputFromConcreteAgent =
    hasMatchingConcreteAgentId &&
    previous.payload.toolInput === undefined &&
    next.payload.toolInput === undefined
  const hasMatchingToolUseId =
    previousToolUseId !== undefined && previousToolUseId === nextToolUseId
  const hasConflictingToolUseId =
    previousToolUseId !== undefined &&
    nextToolUseId !== undefined &&
    previousToolUseId !== nextToolUseId
  const sameUnknownInputFromToolUseId =
    hasMatchingToolUseId &&
    previous.payload.toolInput === undefined &&
    next.payload.toolInput === undefined

  // Failure clears tool name/input; require the exact request and owner.
  if (next.hookEventName === 'PostToolUseFailure') {
    return (
      hasMatchingToolUseId && previousAgentId === nextAgentId && previousAgentType === nextAgentType
    )
  }

  return (
    (next.hookEventName === 'PreToolUse' || next.hookEventName === 'PostToolUse') &&
    nextToolUseId !== undefined &&
    !hasConflictingToolUseId &&
    // Subagents share agent_type; concrete agent or tool-use IDs distinguish them.
    (hasMatchingConcreteAgentId || hasSameExplicitAgentType || hasMatchingToolUseId) &&
    sameToolName &&
    (sameKnownToolInput || sameUnknownInputFromConcreteAgent || sameUnknownInputFromToolUseId)
  )
}

export function shouldInheritClaudeToolUseIdForPermission(
  previous: AgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): boolean {
  if (
    previous?.restoredUnconfirmed ||
    previous?.payload.agentType !== 'claude' ||
    previous.payload.state !== 'working' ||
    previous.hookEventName !== 'PreToolUse' ||
    typeof previous.toolUseId !== 'string' ||
    previous.toolUseId.trim().length === 0 ||
    next.payload.agentType !== 'claude' ||
    next.payload.state !== 'waiting' ||
    next.hookEventName !== 'PermissionRequest' ||
    next.toolUseId !== undefined
  ) {
    return false
  }
  const sameKnownToolInput =
    previous.payload.toolInput !== undefined &&
    previous.payload.toolInput === next.payload.toolInput
  const sameUnknownToolInput =
    previous.payload.toolInput === undefined && next.payload.toolInput === undefined
  if (
    previous.toolAgentId !== next.toolAgentId ||
    previous.toolAgentType !== next.toolAgentType ||
    previous.payload.toolName === undefined ||
    previous.payload.toolName !== next.payload.toolName ||
    (!sameKnownToolInput && !sameUnknownToolInput)
  ) {
    return false
  }
  return true
}

export function attachClaudePermissionToolUseId(
  previous: AgentHookEventPayload | undefined,
  next: AgentHookEventPayload
): AgentHookEventPayload {
  const inheritedToolUseId = previous?.toolUseId
  if (
    !shouldInheritClaudeToolUseIdForPermission(previous, next) ||
    typeof inheritedToolUseId !== 'string'
  ) {
    return next
  }
  return {
    ...next,
    // PermissionRequest omits tool_use_id; PostToolUse reuses the PreToolUse ID.
    toolUseId: inheritedToolUseId
  }
}
