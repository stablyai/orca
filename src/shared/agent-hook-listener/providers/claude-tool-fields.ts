import type { ToolSnapshot } from '../listener-event'
import { deriveToolInputPreview, hasOwnField, readString, toolUpdate } from '../tool-input-preview'
import {
  clearActiveToolFieldsUpdate,
  deriveInteractivePrompt,
  extractToolResponseText
} from '../interactive-tool'
import { readLastAssistantFromTranscript } from '../transcript-lines'

export function extractClaudeToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  const update: ToolSnapshot = {}
  if (eventName === 'PostToolUseFailure') {
    Object.assign(update, clearActiveToolFieldsUpdate())
  } else if (
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse' ||
    eventName === 'PermissionRequest'
  ) {
    const toolName = readString(hookPayload, 'tool_name')
    Object.assign(
      update,
      toolUpdate(
        {
          toolName,
          toolInput: deriveToolInputPreview(toolName, hookPayload.tool_input),
          interactivePrompt: deriveInteractivePrompt(toolName, hookPayload.tool_input, eventName)
        },
        { hasToolInputField: hasOwnField(hookPayload, 'tool_input') }
      )
    )
  }
  if (eventName === 'PostToolUse') {
    const responseText = extractToolResponseText(hookPayload.tool_response)
    if (responseText) {
      update.lastAssistantMessage = responseText
      update.lastAssistantMessageIsToolOutput = true
    }
  }
  if (eventName === 'PostToolUseFailure') {
    const errorText =
      extractToolResponseText(hookPayload.tool_response) ??
      readString(hookPayload, 'error') ??
      readString(hookPayload, 'message')
    if (errorText) {
      update.lastAssistantMessage = errorText
      update.lastAssistantMessageIsToolOutput = true
    }
  }
  if (eventName === 'Stop') {
    const direct = readString(hookPayload, 'last_assistant_message')
    if (direct) {
      update.lastAssistantMessage = direct
    } else {
      const lastFromTranscript = readLastAssistantFromTranscript(hookPayload.transcript_path)
      if (lastFromTranscript) {
        update.lastAssistantMessage = lastFromTranscript
      }
    }
  }
  return update
}
