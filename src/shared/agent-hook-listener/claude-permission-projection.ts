import { isRecord } from '../agent-status-child-work-value-guards'
import type { ClaudeSettledRequest } from './claude-settled-permission-requests'
import type { AgentHookEventPayload } from './listener-event'
import type { HookListenerState } from './listener-state'

export type ClaudePermissionState = {
  version: 1
  knowledge: 'complete' | 'unknown'
  pending?: Omit<ClaudeSettledRequest, 'toolUseId'> & { toolUseId?: string }
}

export function readClaudePermissionState(value: unknown): ClaudePermissionState | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.knowledge !== 'complete' && value.knowledge !== 'unknown')
  ) {
    return undefined
  }
  let pending: ClaudePermissionState['pending']
  if (value.pending !== undefined) {
    if (!isRecord(value.pending)) {
      return undefined
    }
    pending = {}
    for (const key of ['toolUseId', 'toolAgentId', 'toolAgentType'] as const) {
      const field = value.pending[key]
      if (field !== undefined) {
        if (typeof field !== 'string' || !field.trim() || field.length > 256) {
          return undefined
        }
        pending[key] = field.trim()
      }
    }
  }
  return { version: 1, knowledge: value.knowledge, ...(pending ? { pending } : {}) }
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
  const pending = table.pending.at(-1)
  const lead = state.claudeLeadStateByPaneKey.get(event.paneKey)
  if (lead?.state === 'waiting') {
    return { ...event, claudePermissionState: { version: 1, knowledge: 'unknown' } }
  }
  const descriptor = pending
    ? {
        ...(pending.candidates.size === 1
          ? { toolUseId: table.calls.get([...pending.candidates][0])?.id }
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
