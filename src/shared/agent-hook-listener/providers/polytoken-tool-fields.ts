import type { ToolSnapshot } from '../listener-event'
import { clearActiveToolFieldsUpdate, extractToolResponseText } from '../interactive-tool'
import {
  deriveFallbackToolInputPreview,
  deriveToolInputPreview,
  hasOwnField,
  readString,
  toolUpdate
} from '../tool-input-preview'

// Why: Polytoken tool events carry `tool_name` + `input` (captured from 0.8.2 hook stdin), not
// Claude's `tool_input`, so the Claude extractor would never see the arguments.
function derivePolytokenToolInputPreview(
  toolName: string | undefined,
  input: unknown
): string | undefined {
  return deriveToolInputPreview(toolName, input) ?? deriveFallbackToolInputPreview(input)
}

export function extractPolytokenToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  const update: ToolSnapshot = {}
  if (eventName === 'post_tool_use_failure') {
    Object.assign(update, clearActiveToolFieldsUpdate())
    const errorText =
      extractToolResponseText(hookPayload.error) ??
      readString(hookPayload, 'error') ??
      readString(hookPayload, 'message')
    if (errorText) {
      update.lastAssistantMessage = errorText
      update.lastAssistantMessageIsToolOutput = true
    }
    return update
  }
  if (eventName === 'pre_tool_use' || eventName === 'post_tool_use') {
    const toolName = readString(hookPayload, 'tool_name')
    Object.assign(
      update,
      toolUpdate(
        { toolName, toolInput: derivePolytokenToolInputPreview(toolName, hookPayload.input) },
        { hasToolInputField: hasOwnField(hookPayload, 'input') }
      )
    )
  }
  return update
}
