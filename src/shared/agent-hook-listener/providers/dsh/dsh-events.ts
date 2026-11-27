import { isAskUserQuestionTool } from '../../../agent-status/lifecycle/agent-question-answered-intent'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../../agent-status/contracts/agent-status-types'
import type { HookListenerState } from '../../listener-state'
import {
  resolvePrompt,
  resolveToolState,
  shouldIgnoreCompactContinuationUserPromptSubmit
} from '../../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../../provider-event-routing'
import { readString } from '../../tool-input-preview'

/** The session that owns the pane's open DSH row; undefined once its turn or process ended. */
function openLeadSessionId(state: HookListenerState, paneKey: string): string | undefined {
  const previous = state.lastStatusByPaneKey.get(paneKey)
  return previous?.payload.agentType === 'dsh' &&
    !previous.providerSessionOnly &&
    previous.payload.state !== 'done'
    ? previous.providerSession?.id
    : undefined
}

/** The bridge stamps child agents' hooks with their own session_id; only SubagentStart names a child. */
function isChildAgentEvent(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): boolean {
  const sessionId = readString(hookPayload, 'session_id')
  if (!sessionId) {
    return false
  }
  if (state.childSessionIdsByPaneKey.get(paneKey)?.has(sessionId)) {
    return true
  }
  if (eventName !== 'SessionStart' && eventName !== 'UserPromptSubmit') {
    return false
  }
  // A child announces itself before its SubagentStart, always inside a lead turn; an idle lead is being replaced.
  const leadSessionId = openLeadSessionId(state, paneKey)
  return leadSessionId !== undefined && leadSessionId !== sessionId
}

function rememberChildSession(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>
): void {
  // agent_id is the child's session id even when the bridge could not resolve the child agent.
  const childSessionId =
    readString(hookPayload, 'agent_id') ?? readString(hookPayload, 'session_id')
  if (!childSessionId) {
    return
  }
  let children = state.childSessionIdsByPaneKey.get(paneKey)
  if (!children) {
    children = new Set()
    state.childSessionIdsByPaneKey.set(paneKey, children)
  }
  children.add(childSessionId)
}

/** DSH's Claude-shaped bridge lacks Notification/PermissionRequest. ask_user_question blocks between Pre/PostToolUse; unobservable approval pauses remain working. */
export function normalizeDshEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (shouldIgnoreCompactContinuationUserPromptSubmit(eventName, promptText)) {
    return null
  }

  if (eventName === 'SubagentStart') {
    rememberChildSession(state, paneKey, hookPayload)
    return null
  }
  // Subagent edges never restate the lead's turn; resurrecting finished panes from them is #22216.
  if (eventName === 'SubagentStop' || isChildAgentEvent(state, paneKey, eventName, hookPayload)) {
    return null
  }

  const toolName = readString(hookPayload, 'tool_name')

  let stateName: 'working' | 'waiting' | 'done'
  switch (eventName) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      stateName = 'working'
      break
    case 'PreToolUse':
      stateName = isAskUserQuestionTool(toolName) ? 'waiting' : 'working'
      break
    case 'SessionStart':
    case 'Stop':
      stateName = 'done'
      break
    default:
      return null
  }

  const sessionId = readString(hookPayload, 'session_id')
  const leadSessionId = openLeadSessionId(state, paneKey)
  // A session taking over an unsettled row had its announcements dropped; never show the old turn's prompt.
  const resetOnNewTurn =
    isNewTurnEvent('dsh', eventName) ||
    (sessionId !== undefined && leadSessionId !== undefined && leadSessionId !== sessionId)
  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('dsh', eventName, hookPayload),
    { resetOnNewTurn }
  )

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, { resetOnNewTurn }),
    agentType: 'dsh',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    // SessionStart includes create/resume/clear/compact and cannot prove turn completion.
    sessionBoundary: eventName === 'SessionStart' ? true : undefined
  })
}
