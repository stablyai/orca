import type { ToolSnapshot } from '../listener-event'
import {
  deriveToolInputPreview,
  hasAnyOwnField,
  readString,
  toolUpdate
} from '../tool-input-preview'
import { deriveInteractivePrompt } from '../interactive-tool'

// Source of truth: vibe/core/hooks/models.py. pre_tool carries tool_name/tool_input;
// post_tool adds tool_status, tool_output, tool_output_text, tool_error, duration_ms.
// post_agent carries session context only.
export function extractVibeToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (eventName !== 'pre_tool' && eventName !== 'post_tool') {
    return {}
  }
  const toolName = readString(hookPayload, 'tool_name')
  const rawInput = hookPayload.tool_input
  const update = toolUpdate(
    {
      toolName,
      toolInput: deriveToolInputPreview(toolName, rawInput),
      interactivePrompt: deriveInteractivePrompt(toolName, rawInput, eventName)
    },
    { hasToolInputField: hasAnyOwnField(hookPayload, ['tool_input']) }
  )
  // Why: post_tool also carries the tool's result text. Prefer tool_error on failure
  // (it overrides tool_output_text), then tool_output_text, then a stringified
  // tool_output dict. resolveToolState merges these into lastAssistantMessage.
  if (eventName === 'post_tool') {
    const errorText = readString(hookPayload, 'tool_error')
    const outputText = readString(hookPayload, 'tool_output_text')
    const message = errorText ?? outputText
    if (message) {
      update.lastAssistantMessage = message
      update.lastAssistantMessageIsToolOutput = true
    }
  }
  return update
}
