import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'

/** Session open/switch/reset is idle, not a turn. done+sessionBoundary avoids phantom work and 30-minute tui-idle vetoes. */
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

export function isHermesRootSessionEvent(eventName: unknown): boolean {
  return (
    eventName === 'on_session_start' ||
    eventName === 'on_session_reset' ||
    eventName === 'pre_llm_call'
  )
}

// Why: Hermes' post-turn memory/skill review fires tool hooks with no turn of its own.
function admitsHermesEvent(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): boolean {
  const sessionId = typeof hookPayload.session_id === 'string' ? hookPayload.session_id : ''
  const turn = state.hermesTurnByPaneKey.get(paneKey)
  if (eventName === 'pre_llm_call') {
    // `delegate_task` children run as platform "subagent" under their own session ids.
    if (turn && hookPayload.platform === 'subagent') {
      turn.childSessionIds.add(sessionId)
    } else {
      state.hermesTurnByPaneKey.set(paneKey, {
        ended: false,
        childSessionIds: new Set(),
        sessionId
      })
    }
    return true
  }
  if (eventName === 'post_llm_call' || eventName === 'on_session_end') {
    if (turn && !turn.childSessionIds.has(sessionId)) {
      turn.ended = true
    }
    return true
  }
  const isToolEvent = eventName === 'pre_tool_call' || eventName === 'post_tool_call'
  return !(isToolEvent && turn?.ended)
}

/** Status admission compares warm children with their parent; this never supplies restore identity. */
export function withHermesPaneSessionId(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>
): Record<string, unknown> {
  const turn = state.hermesTurnByPaneKey.get(paneKey)
  const sessionId = typeof hookPayload.session_id === 'string' ? hookPayload.session_id : ''
  const isChild = hookPayload.platform === 'subagent' || turn?.childSessionIds.has(sessionId)
  return isChild ? { ...hookPayload, session_id: turn?.sessionId } : hookPayload
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

  if (!admitsHermesEvent(state, paneKey, eventName, hookPayload)) {
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
    // Only session start asserts a new owner awaiting input; turn-end done is not that boundary.
    ...(eventName === 'on_session_start' ? { sessionBoundary: true } : {})
  })
}
