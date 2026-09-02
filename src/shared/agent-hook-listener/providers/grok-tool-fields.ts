import type { ToolSnapshot } from '../listener-event'
import {
  deriveFallbackToolInputPreview,
  deriveToolInputPreview,
  hasAnyOwnField,
  readString,
  toolUpdate
} from '../tool-input-preview'
import {
  clearActiveToolFieldsUpdate,
  deriveInteractivePrompt,
  extractToolResponseText
} from '../interactive-tool'
import { readLastAssistantFromTranscript } from '../transcript-lines'
import { readLastAssistantFromGrokChatHistory } from '../grok-result-discovery'
import { isGrokEvent } from '../provider-event-names'

export function extractGrokToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>,
  grokHome?: string
): ToolSnapshot {
  if (isGrokEvent(eventName, 'pre_tool_use', 'post_tool_use', 'post_tool_use_failure')) {
    const update: ToolSnapshot = {}
    if (isGrokEvent(eventName, 'post_tool_use_failure')) {
      Object.assign(update, clearActiveToolFieldsUpdate())
    } else {
      const toolName =
        readString(hookPayload, 'toolName') ??
        readString(hookPayload, 'tool_name') ??
        readString(hookPayload, 'name')
      const rawInput =
        hookPayload.toolInput ??
        hookPayload.tool_input ??
        hookPayload.input ??
        hookPayload.arguments
      const toolInput =
        deriveToolInputPreview(toolName, rawInput) ?? deriveFallbackToolInputPreview(rawInput)
      // Why: Grok's ask_user_question is auto-allowed via PreToolUse, not PermissionRequest; capture full payload for the live card.
      const interactivePrompt = deriveInteractivePrompt(toolName, rawInput, eventName)
      Object.assign(
        update,
        toolUpdate(
          { toolName, toolInput, interactivePrompt },
          {
            hasToolInputField: hasAnyOwnField(hookPayload, [
              'toolInput',
              'tool_input',
              'input',
              'arguments'
            ])
          }
        )
      )
    }
    if (isGrokEvent(eventName, 'post_tool_use', 'post_tool_use_failure')) {
      const responseText =
        extractToolResponseText(hookPayload.toolResponse) ??
        extractToolResponseText(hookPayload.tool_response) ??
        extractToolResponseText(hookPayload.toolOutput) ??
        extractToolResponseText(hookPayload.tool_output) ??
        readString(hookPayload, 'error') ??
        readString(hookPayload, 'message')
      if (responseText) {
        update.lastAssistantMessage = responseText
        update.lastAssistantMessageIsToolOutput = true
      }
    }
    return update
  }
  if (isGrokEvent(eventName, 'stop', 'session_end', 'stop_failure')) {
    const direct =
      readString(hookPayload, 'lastAssistantMessage') ??
      readString(hookPayload, 'last_assistant_message')
    if (direct) {
      return { lastAssistantMessage: direct }
    }
    const fromTranscript = readLastAssistantFromTranscript(
      hookPayload.transcriptPath ?? hookPayload.transcript_path
    )
    if (fromTranscript) {
      return { lastAssistantMessage: fromTranscript }
    }
    const fromChatHistory = readLastAssistantFromGrokChatHistory(hookPayload, grokHome)
    if (fromChatHistory) {
      return { lastAssistantMessage: fromChatHistory }
    }
  }
  return {}
}
export function isGrokPermissionNotification(message: string | undefined): boolean {
  if (!message) {
    return false
  }
  const lower = message.toLowerCase()
  return (
    lower.includes('permission') ||
    lower.includes('approval') ||
    lower.includes('approve') ||
    lower.includes('allow') ||
    lower.includes('confirm') ||
    lower.includes('needs your') ||
    lower.includes('requires your') ||
    lower.includes('feedback') ||
    lower.includes('clarify') ||
    lower.includes('question')
  )
}

export function getGrokNotificationType(hookPayload: Record<string, unknown>): string | undefined {
  return (
    readString(hookPayload, 'notificationType') ??
    readString(hookPayload, 'notification_type') ??
    readString(hookPayload, 'type')
  )
}

export function isGrokRoutinePermissionPromptNotification(
  notificationType: string | undefined,
  message: string | undefined,
  level: string | undefined
): boolean {
  // Why: Grok emits this before each tool even under bypassPermissions; PreToolUse already covers progress.
  return (
    isGrokEvent(notificationType, 'permission_prompt') &&
    message?.trim().toLowerCase() === 'tool permission requested' &&
    (!level || level.trim().toLowerCase() === 'info')
  )
}
