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

// jcode's six lifecycle points, mapped the way docs/reference/jcode-hook-events.md
// records them. `session_start` is absent on purpose: it returns early below.
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
    // Why: jcode fires session_start on idle TUI open/attach/resume; mapping it
    // to 'working' would show a spinner before the user typed (mirrors Devin).
    clearPaneTurnCacheState(state, paneKey)
    return null
  }

  // Why the gate only: post_tool for the same tool fires after the human already
  // answered, so it must not re-open the question.
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
  // Why flag it: an unmarked message reads as assistant prose downstream, so a failed
  // tool's stderr would render as jcode's reply in native chat.
  const errorIsToolOutput = errorText !== undefined && eventName === 'post_tool'

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, { resetOnNewTurn }),
    agentType: 'jcode',
    // Why: jcode stamps the live model on session_start/turn_start/turn_end, so
    // the row keeps naming the right model after an in-session `/model` switch.
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
