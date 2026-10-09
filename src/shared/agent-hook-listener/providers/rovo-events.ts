import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import {
  isRovoUserInputTool,
  readFirstRovoToolEntry,
  readRovoAttributeString
} from './rovo-tool-fields'
import { readString } from '../tool-input-preview'

/** Rovo's prompt lives under `attributes.user_prompt`, which the generic top-level extractor misses. */
export function readRovoUserPrompt(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): string | undefined {
  return eventName === 'on_user_prompt'
    ? readRovoAttributeString(hookPayload, 'user_prompt')?.trim() || undefined
    : undefined
}

function resolveRovoState(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): 'working' | 'waiting' | 'done' | null {
  switch (eventName) {
    case 'on_user_prompt':
    case 'on_tool_end':
      return 'working'
    case 'on_tool_start': {
      const call = readFirstRovoToolEntry(hookPayload, 'tool_calls')
      return isRovoUserInputTool(call ? readString(call, 'tool_name') : undefined)
        ? 'waiting'
        : 'working'
    }
    case 'on_tool_permission':
      return 'waiting'
    case 'on_complete':
    case 'on_error':
      return 'done'
    default:
      // Why: on_session_start/on_interactive_ready are idle signals, not turn state.
      return null
  }
}

export function normalizeRovoEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const stateName = resolveRovoState(eventName, hookPayload)
  if (!stateName) {
    return null
  }
  const resetOnNewTurn = isNewTurnEvent('rovo', eventName)
  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('rovo', eventName, hookPayload),
    { resetOnNewTurn }
  )
  const status = readRovoAttributeString(hookPayload, 'status')
  // Why: on_complete reports `completed` for a normal finish; anything else (e.g. cancelled) was cut short.
  const interrupted =
    eventName === 'on_complete' && status !== undefined && status !== 'completed' ? true : undefined
  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, { resetOnNewTurn }),
    agentType: 'rovo',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    interrupted
  })
}
