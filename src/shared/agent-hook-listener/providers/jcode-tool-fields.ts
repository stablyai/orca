import type { ToolSnapshot } from '../listener-event'
import { hasOwnField, readString, toolUpdate } from '../tool-input-preview'

// Why: jcode's post_tool hook reports the tool name but no tool input (only
// the pre_tool gate hook receives the input JSON, and Orca does not gate).
export function extractJcodeToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (eventName === 'post_tool') {
    const toolName = readString(hookPayload, 'tool_name')
    return toolUpdate(
      { toolName, toolInput: undefined },
      // Why: hasToolInputField with an undefined input clears any stale tool
      // input from the previous turn instead of inheriting it.
      { hasToolInputField: hasOwnField(hookPayload, 'tool_name') }
    )
  }
  if (eventName === 'turn_end') {
    const message =
      readString(hookPayload, 'last_assistant_message') ??
      readString(hookPayload, 'last_assistant_text')
    if (message) {
      return { lastAssistantMessage: message }
    }
  }
  return {}
}
