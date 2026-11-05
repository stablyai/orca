import type { ToolSnapshot } from '../listener-event'
import {
  deriveFallbackToolInputPreview,
  deriveToolInputPreview,
  readString,
  toolUpdate
} from '../tool-input-preview'
import { readFirstString } from '../interactive-tool'
import { readLastAssistantFromTranscript } from '../transcript-lines'
import { isAntigravityStopStillBusy } from './antigravity-event-rules'

export function readAntigravityToolCall(hookPayload: Record<string, unknown>): {
  toolName?: string
  toolInputSource?: unknown
} {
  const toolCall = hookPayload.toolCall
  if (typeof toolCall !== 'object' || toolCall === null) {
    return {}
  }
  const record = toolCall as Record<string, unknown>
  return {
    toolName: readFirstString(record, ['name', 'toolName', 'tool_name']),
    toolInputSource: record.args
  }
}

export function extractAntigravityToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (eventName === 'PreToolUse' || eventName === 'PostToolUse') {
    const toolCall = readAntigravityToolCall(hookPayload)
    const toolName = toolCall.toolName
    const toolInput =
      deriveToolInputPreview(toolName, toolCall.toolInputSource) ??
      deriveFallbackToolInputPreview(toolCall.toolInputSource)
    return toolUpdate(
      { toolName, toolInput },
      { hasToolInputField: toolCall.toolInputSource !== undefined }
    )
  }
  if (eventName === 'Stop') {
    if (isAntigravityStopStillBusy(hookPayload)) {
      return {}
    }
    const message =
      readString(hookPayload, 'last_assistant_message') ??
      readLastAssistantFromTranscript(hookPayload.transcriptPath ?? hookPayload.transcript_path)
    if (message) {
      return { lastAssistantMessage: message }
    }
  }
  return {}
}
