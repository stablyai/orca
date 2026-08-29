import type { ToolSnapshot } from '../listener-event'
import {
  deriveToolInputPreview,
  hasAnyOwnField,
  readString,
  toolUpdate
} from '../tool-input-preview'

export function extractGeminiToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (
    eventName === 'BeforeTool' ||
    eventName === 'AfterTool' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse'
  ) {
    const toolName = readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name')
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveToolInputPreview(toolName, hookPayload.args) ??
      deriveToolInputPreview(toolName, hookPayload.input)
    return toolUpdate(
      { toolName, toolInput },
      { hasToolInputField: hasAnyOwnField(hookPayload, ['tool_input', 'args', 'input']) }
    )
  }
  if (eventName === 'AfterAgent') {
    const message = readString(hookPayload, 'prompt_response')
    if (message) {
      return { lastAssistantMessage: message }
    }
  }
  return {}
}
