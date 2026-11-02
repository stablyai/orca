import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import {
  resolvePrompt,
  resolveToolState,
  shouldIgnoreCompactContinuationUserPromptSubmit
} from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'

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

  // Child-stamped session IDs/general-purpose types cannot distinguish lead turns; ignore lifecycle to avoid resurrecting finished panes (#22216).
  if (eventName === 'SubagentStart' || eventName === 'SubagentStop') {
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

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('dsh', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('dsh', eventName) }
  )

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: isNewTurnEvent('dsh', eventName)
    }),
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
