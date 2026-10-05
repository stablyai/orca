import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'

/** `on_session_start` is a session boundary, not a turn: Hermes fires it when a session is
 *  opened, switched or reset, and the TUI then sits on its composer awaiting input. Landing it
 *  as `working` showed a phantom spinner on an idle pane and left `terminal wait --for tui-idle`
 *  with a fresh `working` row to veto against until the 30-minute staleness window expired.
 *  `done` + `sessionBoundary` is the same shape Claude and the compatible-lifecycle providers
 *  already use for their own SessionStart. */
const HERMES_EVENT_STATES: Record<string, 'working' | 'waiting' | 'done'> = {
  on_session_start: 'done',
  on_session_end: 'done',
  on_session_finalize: 'done',
  on_session_reset: 'done',
  post_llm_call: 'done',
  pre_approval_request: 'waiting',
  pre_llm_call: 'working',
  pre_tool_call: 'working',
  post_tool_call: 'working',
  post_approval_response: 'working'
}

export function normalizeHermesEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const stateName = typeof eventName === 'string' ? HERMES_EVENT_STATES[eventName] : undefined

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
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    // Why only this event: a boundary row means "a new session owns the pane and is awaiting
    // input", which cannot arrive mid-turn. A turn-end `done` must not claim the same.
    ...(eventName === 'on_session_start' ? { sessionBoundary: true } : {})
  })
}
