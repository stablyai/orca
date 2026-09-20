import type { ToolSnapshot } from '../listener-event'
import {
  deriveToolInputPreview,
  hasAnyOwnField,
  readString,
  toolUpdate
} from '../tool-input-preview'
import { deriveInteractivePrompt, extractToolResponseText } from '../interactive-tool'

export function extractCodexToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  const update: ToolSnapshot = {}
  if (
    eventName === 'PreToolUse' ||
    eventName === 'PermissionRequest' ||
    eventName === 'PostToolUse'
  ) {
    const toolName = readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name')
    const rawInput = hookPayload.tool_input ?? hookPayload.input ?? hookPayload.arguments
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveToolInputPreview(toolName, hookPayload.input) ??
      deriveToolInputPreview(toolName, hookPayload.arguments)
    Object.assign(
      update,
      toolUpdate(
        {
          toolName,
          toolInput,
          interactivePrompt: deriveInteractivePrompt(toolName, rawInput, eventName)
        },
        { hasToolInputField: hasAnyOwnField(hookPayload, ['tool_input', 'input', 'arguments']) }
      )
    )
  }
  if (eventName === 'PostToolUse') {
    // Why: Codex posts the tool result on PostToolUse; surface it as the status row summary.
    const responseText = extractToolResponseText(hookPayload.tool_response)
    if (responseText) {
      update.lastAssistantMessage = responseText
    }
  }
  if (eventName === 'Stop' || eventName === 'SubagentStop') {
    const message = readString(hookPayload, 'last_assistant_message')
    if (message) {
      update.lastAssistantMessage = message
    }
  }
  return update
}
