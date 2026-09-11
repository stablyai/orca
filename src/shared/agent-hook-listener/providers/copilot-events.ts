import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { readFirstString } from '../interactive-tool'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import {
  isAskUserTool,
  normalizeCopilotEventName,
  resolveCopilotEventName
} from './copilot-tool-fields'

// Why: Copilot PermissionRequest fires before allow/ask/deny (stays working); ask_user and notification prompts are the real blocked signals.
export function normalizeCopilotEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const normalizedEventName = normalizeCopilotEventName(
    resolveCopilotEventName(eventName, hookPayload)
  )
  const notificationType = readFirstString(hookPayload, ['notification_type', 'notificationType'])
  const isBlockingNotification =
    normalizedEventName === 'Notification' &&
    (notificationType === 'permission_prompt' || notificationType === 'elicitation_dialog')
  const toolSnapshot = extractToolFields('copilot', normalizedEventName, hookPayload)
  const isAskUserPrompt =
    (normalizedEventName === 'PreToolUse' || normalizedEventName === 'PermissionRequest') &&
    isAskUserTool(toolSnapshot.toolName)
  const stateName =
    normalizedEventName === 'SessionStart' ||
    normalizedEventName === 'UserPromptSubmit' ||
    normalizedEventName === 'PostToolUse' ||
    normalizedEventName === 'PostToolUseFailure'
      ? 'working'
      : isBlockingNotification || isAskUserPrompt
        ? 'blocked'
        : normalizedEventName === 'PreToolUse' || normalizedEventName === 'PermissionRequest'
          ? 'working'
          : normalizedEventName === 'Stop' || normalizedEventName === 'SessionEnd'
            ? 'done'
            : normalizedEventName === 'ErrorOccurred'
              ? hookPayload.recoverable === true
                ? 'working'
                : 'done'
              : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(state, paneKey, toolSnapshot, {
    resetOnNewTurn: isNewTurnEvent('copilot', normalizedEventName)
  })

  const effectivePrompt = normalizedEventName === 'Notification' ? '' : promptText

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, effectivePrompt, {
      resetOnNewTurn: isNewTurnEvent('copilot', normalizedEventName)
    }),
    agentType: 'copilot',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput
  })
}
