import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'

export function normalizeHermesEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const stateName =
    eventName === 'pre_approval_request'
      ? 'waiting'
      : eventName === 'post_llm_call' ||
          eventName === 'on_session_end' ||
          eventName === 'on_session_finalize' ||
          eventName === 'on_session_reset'
        ? 'done'
        : eventName === 'on_session_start' ||
            eventName === 'pre_llm_call' ||
            eventName === 'pre_tool_call' ||
            eventName === 'post_tool_call' ||
            eventName === 'post_approval_response'
          ? 'working'
          : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('hermes', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('hermes', eventName) }
  )

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: isNewTurnEvent('hermes', eventName)
    }),
    agentType: 'hermes',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage
  })
}
