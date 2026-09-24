import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { createMuseSessionLogState, readMusePendingUserInput } from '../../muse-session-log'
import type { HookListenerState, MusePaneState } from '../listener-state'
import {
  resolvePrompt,
  resolveToolState,
  shouldIgnoreCompactContinuationUserPromptSubmit
} from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'

const MAX_TRACKED_CHILD_SESSIONS = 64

function getMusePaneState(state: HookListenerState, paneKey: string): MusePaneState {
  let pane = state.musePaneStateByPaneKey.get(paneKey)
  if (!pane) {
    pane = { childSessionIds: new Set() }
    state.musePaneStateByPaneKey.set(paneKey, pane)
  }
  return pane
}

function rememberChildSession(pane: MusePaneState, childSessionId: string): void {
  pane.childSessionIds.add(childSessionId)
  if (pane.childSessionIds.size > MAX_TRACKED_CHILD_SESSIONS) {
    const oldest = pane.childSessionIds.values().next().value
    if (oldest !== undefined) {
      pane.childSessionIds.delete(oldest)
    }
  }
}

function isChildSessionEvent(pane: MusePaneState, hookPayload: Record<string, unknown>): boolean {
  const sessionId = readString(hookPayload, 'session_id')
  if (!sessionId) {
    return false
  }
  // Why: Muse 1.3 child sessions reuse their session id as turn id; that covers a child whose
  // SubagentStart predates this listener (Orca restart, relay reconnect).
  return pane.childSessionIds.has(sessionId) || readString(hookPayload, 'turn_id') === sessionId
}

/** True while a Muse pane has a known session log the transcript poll can read. */
export function hasMuseSessionLog(state: HookListenerState, paneKey: string): boolean {
  return state.musePaneStateByPaneKey.get(paneKey)?.log !== undefined
}

// Muse uses Claude-compatible hook events but retains its own agent identity.
export function normalizeMuseEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (shouldIgnoreCompactContinuationUserPromptSubmit(eventName, promptText)) {
    return null
  }

  const pane = getMusePaneState(state, paneKey)
  if (eventName === 'SubagentStart') {
    const childSessionId =
      readString(hookPayload, 'child_session_id') ?? readString(hookPayload, 'session_id')
    if (childSessionId) {
      rememberChildSession(pane, childSessionId)
    }
    return null
  }
  if (isChildSessionEvent(pane, hookPayload)) {
    return null
  }
  const sessionId = readString(hookPayload, 'session_id')
  if (sessionId && pane.log?.sessionId !== sessionId) {
    pane.log = createMuseSessionLogState(sessionId)
  }

  const toolName = readString(hookPayload, 'tool_name')
  let toolEventName = eventName
  let toolPayload = hookPayload
  let stateName: 'working' | 'waiting' | 'done'
  switch (eventName) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      stateName = 'working'
      pane.pendingApproval = undefined
      break
    case 'PreToolUse':
      // Keep pendingApproval: the transcript poll replays this body while the approval is visible.
      stateName = isAskUserQuestionTool(toolName) ? 'waiting' : 'working'
      break
    case 'PermissionRequest':
      pane.pendingApproval = { toolName, toolInput: hookPayload.tool_input }
      return null
    case 'Notification':
      if (hookPayload.notification_type !== 'permission_prompt') {
        return null
      }
      stateName = 'waiting'
      toolEventName = 'PermissionRequest'
      toolPayload = {
        ...hookPayload,
        tool_name: pane.pendingApproval?.toolName,
        tool_input: pane.pendingApproval?.toolInput
      }
      break
    case 'Stop':
    case 'StopFailure':
      stateName = 'done'
      pane.pendingApproval = undefined
      break
    default:
      return null
  }

  if (stateName === 'working' && pane.log) {
    // Why: Muse fires no hook for `request_user_input`; its session log is the only structured signal.
    const pendingInput = readMusePendingUserInput(pane.log, readString(hookPayload, 'turn_id'))
    if (pendingInput) {
      stateName = 'waiting'
      toolEventName = 'PreToolUse'
      toolPayload = {
        ...hookPayload,
        tool_name: 'request_user_input',
        tool_input: { questions: pendingInput.questions }
      }
    }
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('muse', toolEventName, toolPayload),
    { resetOnNewTurn: isNewTurnEvent('muse', eventName) }
  )

  const interrupted =
    eventName === 'Stop' && hookPayload['is_interrupt'] === true ? true : undefined

  return normalizeAgentStatusPayload({
    state: stateName,
    // Why: Notification's `message` is status copy ("<dir> — waiting for approval"), not the user's prompt.
    prompt: resolvePrompt(state, paneKey, eventName === 'Notification' ? '' : promptText, {
      resetOnNewTurn: isNewTurnEvent('muse', eventName)
    }),
    agentType: 'muse',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    interrupted
  })
}
