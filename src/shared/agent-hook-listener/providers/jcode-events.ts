import {
  normalizeAgentStatusPayload,
  type AgentStatusState,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { clearPaneTurnCacheState, type HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'
import { isJcodeUserInputTool } from './jcode-tool-fields'

// Lifecycle mapping follows docs/reference/jcode-hook-events.md; idle session_start takes the early path.
const JCODE_EVENT_STATES: Record<string, AgentStatusState> = {
  turn_start: 'working',
  pre_tool: 'working',
  post_tool: 'working',
  turn_end: 'done',
  session_end: 'done'
}

export function normalizeJcodeEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (eventName === 'session_start') {
    // Idle open/attach/resume must not assert working before input.
    clearPaneTurnCacheState(state, paneKey)
    return null
  }

  // Only pre_tool can open a human-input wait; post_tool must not reopen answered questions.
  const stateName =
    eventName === 'pre_tool' && isJcodeUserInputTool(readString(hookPayload, 'tool_name'))
      ? 'waiting'
      : JCODE_EVENT_STATES[String(eventName)]
  if (!stateName) {
    return null
  }

  const resetOnNewTurn = isNewTurnEvent('jcode', eventName)
  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('jcode', eventName, hookPayload),
    { resetOnNewTurn }
  )
  // Why the error text first: a failed turn's own message beats the reply it never replaced.
  const errorText = hookPayload.status === 'error' ? readString(hookPayload, 'error') : undefined
  // Mark tool errors so stderr does not render as assistant prose in native chat.
  const errorIsToolOutput = errorText !== undefined && eventName === 'post_tool'

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, { resetOnNewTurn }),
    agentType: 'jcode',
    // Keep live model stamps after in-session /model switches.
    model: readString(hookPayload, 'model'),
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: errorText ?? snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: errorIsToolOutput
      ? true
      : snapshot.lastAssistantMessageIsToolOutput
  })
}
