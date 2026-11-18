import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../../agent-status/contracts/agent-status-types'
import type { HermesPaneTurn, HookListenerState } from '../../listener-state'
import { resolvePrompt, resolveToolState } from '../../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../../provider-event-routing'

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

const HERMES_TURN_LIFECYCLE_EVENTS = new Set<unknown>([
  'on_session_start',
  'on_session_end',
  'on_session_finalize',
  'on_session_reset',
  'pre_llm_call',
  'post_llm_call'
])

export function isHermesRootSessionEvent(eventName: unknown): boolean {
  return (
    eventName === 'on_session_start' ||
    eventName === 'on_session_reset' ||
    eventName === 'pre_llm_call'
  )
}

/** `delegate_task` children run as platform "subagent"; hooks that omit platform are matched by session id. */
function isHermesChildEvent(
  turn: HermesPaneTurn | undefined,
  hookPayload: Record<string, unknown>
): boolean {
  const { platform, session_id: sessionId } = hookPayload
  if (typeof platform === 'string' && platform) {
    return platform === 'subagent'
  }
  return typeof sessionId === 'string' && turn?.childSessionIds.has(sessionId) === true
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
  if (HERMES_TURN_LIFECYCLE_EVENTS.has(eventName) && isHermesChildEvent(turn, hookPayload)) {
    // A child's own turn, often a background one outliving the root's, never starts or ends the pane's.
    if (sessionId) {
      turn?.childSessionIds.add(sessionId)
    }
    return false
  }
  if (eventName === 'pre_llm_call') {
    // Children are remembered across root turns so a late child end cannot close a newer one.
    const childSessionIds = turn?.childSessionIds ?? new Set<string>()
    childSessionIds.delete(sessionId)
    state.hermesTurnByPaneKey.set(paneKey, { ended: false, childSessionIds, sessionId })
    return true
  }
  if ((eventName === 'post_llm_call' || eventName === 'on_session_end') && turn) {
    turn.ended = true
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
  return isHermesChildEvent(turn, hookPayload)
    ? { ...hookPayload, session_id: turn?.sessionId }
    : hookPayload
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
