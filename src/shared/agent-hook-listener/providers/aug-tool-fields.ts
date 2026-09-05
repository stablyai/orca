import type { ToolSnapshot } from '../listener-event'
import { deriveInteractivePrompt } from '../interactive-tool'
import {
  deriveFallbackToolInputPreview,
  deriveToolInputPreview,
  hasOwnField,
  readString,
  toolUpdate
} from '../tool-input-preview'

// Why: Auggie's PostToolUse carries plain-string tool_error/tool_output (not Claude's tool_response
// object), and its Stop only exposes conversation.agentTextResponse — no transcript_path to fall back to.
export function extractAuggieToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (eventName === 'PreToolUse' || eventName === 'PostToolUse') {
    const toolName = readString(hookPayload, 'tool_name')
    const update: ToolSnapshot = toolUpdate(
      {
        toolName,
        // Why: fall back to obvious arg fields so a new/unmapped Auggie tool still shows a value, not a blank row.
        toolInput:
          deriveToolInputPreview(toolName, hookPayload.tool_input) ??
          deriveFallbackToolInputPreview(hookPayload.tool_input),
        interactivePrompt: deriveInteractivePrompt(toolName, hookPayload.tool_input, eventName)
      },
      { hasToolInputField: hasOwnField(hookPayload, 'tool_input') }
    )
    if (eventName === 'PostToolUse') {
      const responseText =
        readString(hookPayload, 'tool_error') ?? readString(hookPayload, 'tool_output')
      if (responseText) {
        update.lastAssistantMessage = responseText
      }
    }
    return update
  }
  if (
    eventName === 'Stop' &&
    typeof hookPayload.conversation === 'object' &&
    hookPayload.conversation !== null
  ) {
    const text = readString(
      hookPayload.conversation as Record<string, unknown>,
      'agentTextResponse'
    )
    if (text) {
      return { lastAssistantMessage: text }
    }
  }
  return {}
}
