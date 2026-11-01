import { isRecord } from '../agent-status-child-work-value-guards'
import type { ClaudeSettledRequest } from './claude-settled-permission-requests'
import type { AgentHookEventPayload } from './listener-event'
import type { HookListenerState } from './listener-state'

export type ClaudePermissionState = {
  version: 1
  knowledge: 'complete' | 'unknown'
  pending?: Omit<ClaudeSettledRequest, 'toolUseId'> & { toolUseId?: string }
}

/** The row's own hook identity, carried aside on the wire while legacy fields name the pending request. */
type ClaudePermissionCause = {
  hookEventName?: string
  toolUseId?: string
  toolAgentId?: string
  toolAgentType?: string
}

export type ClaudePermissionWireState = ClaudePermissionState & { cause?: ClaudePermissionCause }

function readIdentity<K extends string>(
  value: Record<string, unknown>,
  keys: readonly K[]
): Partial<Record<K, string>> | undefined {
  const identity: Partial<Record<K, string>> = {}
  for (const key of keys) {
    const field = value[key]
    if (field !== undefined) {
      if (typeof field !== 'string' || !field.trim() || field.length > 256) {
        return undefined
      }
      identity[key] = field.trim()
    }
  }
  return identity
}

const PENDING_KEYS = ['toolUseId', 'toolAgentId', 'toolAgentType'] as const
const CAUSE_KEYS = ['hookEventName', ...PENDING_KEYS] as const

export function readClaudePermissionState(
  value: unknown
): { state: ClaudePermissionState; cause?: ClaudePermissionCause } | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.knowledge !== 'complete' && value.knowledge !== 'unknown')
  ) {
    return undefined
  }
  const pending = isRecord(value.pending) ? readIdentity(value.pending, PENDING_KEYS) : undefined
  const cause = isRecord(value.cause) ? readIdentity(value.cause, CAUSE_KEYS) : undefined
  if ((value.pending !== undefined && !pending) || (value.cause !== undefined && !cause)) {
    return undefined
  }
  return {
    state: { version: 1, knowledge: value.knowledge, ...(pending ? { pending } : {}) },
    ...(cause ? { cause } : {})
  }
}

/** Project the request's own card while unrelated hooks continue updating the underlying lead. */
export function projectClaudePermissionState(
  state: HookListenerState,
  event: AgentHookEventPayload
): AgentHookEventPayload {
  const table = state.claudePermissionByPaneKey.get(event.paneKey)
  if (!table || event.source !== 'claude') {
    return event
  }
  const tracked = table.pending.at(-1)
  const pending = tracked ?? table.overflow
  const lead = state.claudeLeadStateByPaneKey.get(event.paneKey)
  if (lead?.state === 'waiting') {
    return { ...event, claudePermissionState: { version: 1, knowledge: 'unknown' } }
  }
  const descriptor = pending
    ? {
        ...(tracked?.candidates.size === 1
          ? { toolUseId: table.calls.get([...tracked.candidates][0])?.id }
          : {}),
        ...(pending.call.owner ? { toolAgentId: pending.call.owner } : {}),
        ...(pending.agentType ? { toolAgentType: pending.agentType } : {})
      }
    : undefined
  const claudePermissionState: ClaudePermissionState = {
    version: 1,
    knowledge: table.complete ? 'complete' : 'unknown',
    ...(descriptor ? { pending: descriptor } : {})
  }
  if (!pending) {
    return { ...event, claudePermissionState }
  }
  const {
    toolName,
    toolInput,
    interactivePrompt,
    lastAssistantMessage,
    lastAssistantMessageIsToolOutput
  } = pending.snapshot
  return {
    ...event,
    claudePermissionState,
    payload: {
      ...event.payload,
      state: 'waiting',
      workingMode: undefined,
      toolName,
      toolInput,
      interactivePrompt,
      lastAssistantMessage,
      lastAssistantMessageIsToolOutput,
      interrupted: undefined,
      mainAgent:
        pending.call.owner === undefined
          ? { state: 'waiting', stateStartedAt: pending.startedAt }
          : event.payload.mainAgent
    }
  }
}

/** Execution-host restatements derive the projection from current state; a hook's proof never carries over. */
export function restateClaudePermissionRow(
  state: HookListenerState,
  row: AgentHookEventPayload
): AgentHookEventPayload {
  return projectClaudePermissionState(state, {
    ...row,
    claudeSettledRequests: undefined,
    claudePermissionState: undefined
  })
}
