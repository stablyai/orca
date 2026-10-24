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

/**
 * Admits only an event whose turn has not already ended on this pane. Hermes sends its own
 * `pre_tool_call`/`post_tool_call`/`post_approval_response` hooks over an async channel that
 * does not guarantee delivery order against the turn-end hook; a tool-call event that logically
 * preceded the turn's end can still arrive seconds after it. Without this gate that late
 * delivery is mapped straight to `working` and silently reopens a pane the user already saw
 * finish (status regression: "done" flips back to "working" seconds later, with no new turn).
 *
 * `pre_llm_call`/`on_session_start` open a new turn and clear the latch; every other `done`
 * event (`post_llm_call` and the session-end/finalize/reset trio) closes the current turn.
 * Every remaining event is admitted only while the current turn is still open.
 */
const HERMES_TURN_OPEN_EVENTS = new Set(['pre_llm_call', 'on_session_start'])
const HERMES_TURN_CLOSE_EVENTS = new Set([
  'post_llm_call',
  'on_session_end',
  'on_session_finalize',
  'on_session_reset'
])

function admitsHermesEvent(state: HookListenerState, paneKey: string, eventName: string): boolean {
  const current = state.hermesTurnByPaneKey.get(paneKey)
  if (HERMES_TURN_OPEN_EVENTS.has(eventName)) {
    state.hermesTurnByPaneKey.set(paneKey, { turnKey: (current?.turnKey ?? 0) + 1, ended: false })
    return true
  }
  if (HERMES_TURN_CLOSE_EVENTS.has(eventName)) {
    if (current) {
      state.hermesTurnByPaneKey.set(paneKey, { ...current, ended: true })
    }
    return true
  }
  return current?.ended !== true
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

  // Why: a stale sub-turn event (see admitsHermesEvent) restates activity that already ended;
  // it must not resurrect `working` over the `done` already shown for this turn.
  if (typeof eventName === 'string' && !admitsHermesEvent(state, paneKey, eventName)) {
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
