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

/**
 * Normalize root metadata from Orca's native DSH plugin and older Claude-compatible
 * bridge events. Legacy Stop precedes finalization and cannot prove readiness.
 * Native lifecycle HTTP reports are metadata only; readiness uses ordered PTY frames.
 * ask_user_question marks the tool-owned question until its result arrives.
 */
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

  // Why: the bridge stamps the *child's* session id on both subagent events and labels
  // every child `general-purpose`, so a child turn cannot be told from the lead's. Muse
  // (#22216) showed what that costs: child hooks flip a finished pane back to working.
  if (eventName === 'SubagentStart' || eventName === 'SubagentStop') {
    return null
  }

  const toolName = readString(hookPayload, 'tool_name')

  let stateName: 'working' | 'waiting' | 'done'
  switch (eventName) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
    case 'NativeRunning':
    case 'Stop':
      stateName = 'working'
      break
    case 'PreToolUse':
      stateName = isAskUserQuestionTool(toolName) ? 'waiting' : 'working'
      break
    case 'SessionStart':
    case 'NativeIdle':
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
    // SessionStart precedes the composer; native idle follows finalization, unlike Stop.
    sessionBoundary: eventName === 'SessionStart' ? true : undefined,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: isNewTurnEvent('dsh', eventName)
    }),
    agentType: 'dsh',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput
  })
}
