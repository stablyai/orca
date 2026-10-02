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

function readCompatibleState(
  eventName: unknown,
  payload: Record<string, unknown>
): 'working' | 'waiting' | 'done' | null {
  switch (eventName) {
    case 'SessionStart':
      // Compaction restarts the session during an active turn.
      return ['startup', 'resume', 'clear', 'new'].includes(String(payload.source)) ? 'done' : null
    case 'UserPromptSubmit':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return 'working'
    case 'PreToolUse':
      return isAskUserQuestionTool(readString(payload, 'tool_name')) ? 'waiting' : 'working'
    case 'PermissionRequest':
      return 'waiting'
    case 'Stop':
    case 'StopFailure':
    case 'SessionEnd':
      return 'done'
    case 'PostCompact':
      return payload.trigger === 'manual' ? 'done' : null
    case 'Notification':
      if (
        payload.notification_type === 'permission_prompt' ||
        payload.notification_type === 'elicitation_dialog'
      ) {
        return 'waiting'
      }
      return payload.notification_type === 'idle_prompt' ? 'done' : null
    default:
      return null
  }
}

export function normalizeCompatibleLifecycleEvent(
  source: 'qoder' | 'codebuddy',
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (shouldIgnoreCompactContinuationUserPromptSubmit(eventName, promptText)) {
    return null
  }
  // CodeBuddy emits SessionStart after UserPromptSubmit, so it cannot settle a turn.
  if (source === 'codebuddy' && eventName === 'SessionStart') {
    return null
  }
  const stateName =
    source === 'codebuddy' && eventName === 'PreToolUse'
      ? 'working'
      : readCompatibleState(eventName, hookPayload)
  if (!stateName) {
    return null
  }
  const resetOnNewTurn = isNewTurnEvent(source, eventName)
  const toolFields = extractToolFields(source, eventName, hookPayload)
  if (
    source === 'codebuddy' &&
    eventName === 'Notification' &&
    hookPayload.notification_type === 'permission_prompt' &&
    hookPayload.message === 'needs your permission to use AskUserQuestion'
  ) {
    toolFields.toolName = 'AskUserQuestion'
  }
  const snapshot = resolveToolState(state, paneKey, toolFields, { resetOnNewTurn })
  return normalizeAgentStatusPayload({
    state: stateName,
    agentType: source,
    prompt: resolvePrompt(
      state,
      paneKey,
      source === 'codebuddy' && eventName === 'Notification' ? '' : promptText,
      { resetOnNewTurn }
    ),
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    sessionBoundary: eventName === 'SessionStart' || eventName === 'PostCompact' ? true : undefined,
    interrupted: eventName === 'Stop' && hookPayload.is_interrupt === true ? true : undefined,
    mainAgent:
      eventName === 'StopFailure'
        ? { state: 'done', outcome: 'failure', stateStartedAt: Date.now() }
        : undefined
  })
}
