import type { ToolSnapshot } from '../listener-event'
import {
  deriveFallbackToolInputPreview,
  deriveToolInputPreview,
  hasOwnField,
  readString,
  toolUpdate
} from '../tool-input-preview'
import { extractToolResponseText } from '../interactive-tool'
import { readLastCommandCodeAssistantFromTranscript } from '../command-code-transcript'

export function extractCommandCodeToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (eventName === 'PreToolUse' || eventName === 'PostToolUse') {
    const toolName =
      readString(hookPayload, 'tool_name') ??
      readString(hookPayload, 'toolName') ??
      readString(hookPayload, 'tool_display_name')
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveFallbackToolInputPreview(hookPayload.tool_input)
    const update: ToolSnapshot = toolUpdate(
      { toolName, toolInput },
      { hasToolInputField: hasOwnField(hookPayload, 'tool_input') }
    )
    if (eventName === 'PostToolUse') {
      const responseText =
        extractToolResponseText(hookPayload.tool_response) ??
        extractToolResponseText(hookPayload.tool_output)
      if (responseText) {
        update.lastAssistantMessage = responseText
      }
    }
    return update
  }
  if (eventName === 'Stop') {
    const direct = readString(hookPayload, 'last_assistant_message')
    if (direct) {
      return { lastAssistantMessage: direct }
    }
    const fromTranscript = readLastCommandCodeAssistantFromTranscript(
      hookPayload.transcript_path ?? hookPayload.transcriptPath
    )
    if (fromTranscript) {
      return { lastAssistantMessage: fromTranscript }
    }
  }
  return {}
}
