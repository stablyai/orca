import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'

// Why: Auggie has no PermissionRequest; PreToolUse is the only signal for "blocked on user
// input" (its ask-user-style tool auto-runs). PromptSubmit (newer CLI builds) is the per-turn
// working boundary; PreToolUse/PostToolUse still cover tool activity within the turn.
export function normalizeAuggieEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const toolName = readString(hookPayload, 'tool_name')
  const isUserInputTool = isAskUserQuestionTool(toolName)

  const stateName =
    eventName === 'PromptSubmit' ||
    eventName === 'PostToolUse' ||
    (eventName === 'PreToolUse' && !isUserInputTool)
      ? 'working'
      : eventName === 'PreToolUse' && isUserInputTool
        ? 'waiting'
        : eventName === 'SessionStart' || eventName === 'SessionEnd' || eventName === 'Stop'
          ? 'done'
          : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('aug', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('aug', eventName) }
  )

  const interrupted =
    eventName === 'Stop' && hookPayload['agent_stop_cause'] === 'interrupted' ? true : undefined

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: isNewTurnEvent('aug', eventName)
    }),
    agentType: 'aug',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    interrupted,
    sessionBoundary: eventName === 'SessionStart' || eventName === 'SessionEnd' ? true : undefined
  })
}

// Why: Auggie's only prompt field is nested conversation.userPrompt (Stop only); the shared
// extractPromptText/hasExplicitUserPrompt pair only reads top-level payload keys.
export function hasExplicitAuggiePrompt(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): boolean {
  return (
    eventName === 'Stop' &&
    typeof hookPayload.conversation === 'object' &&
    hookPayload.conversation !== null &&
    readString(hookPayload.conversation as Record<string, unknown>, 'userPrompt') !== undefined
  )
}
