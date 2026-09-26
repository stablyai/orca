import type { ToolSnapshot } from '../listener-event'
import {
  deriveFallbackToolInputPreview,
  deriveToolInputPreview,
  hasAnyOwnField,
  readString,
  toolUpdate
} from '../tool-input-preview'
import { extractToolResponseText, readFirstString } from '../interactive-tool'

export function extractAmpToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (eventName === 'tool.call' || eventName === 'tool.result') {
    const toolName =
      readString(hookPayload, 'tool') ??
      readString(hookPayload, 'toolName') ??
      readString(hookPayload, 'name')
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.input) ??
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveToolInputPreview(toolName, hookPayload.arguments) ??
      // Why: Amp plugin tools can have arbitrary names; fall back to obvious arg fields instead of an empty tool preview.
      deriveFallbackToolInputPreview(hookPayload.input) ??
      deriveFallbackToolInputPreview(hookPayload.tool_input) ??
      deriveFallbackToolInputPreview(hookPayload.arguments)
    const update: ToolSnapshot = toolUpdate(
      { toolName, toolInput },
      { hasToolInputField: hasAnyOwnField(hookPayload, ['input', 'tool_input', 'arguments']) }
    )
    if (eventName === 'tool.result') {
      const responseText =
        readFirstString(hookPayload, ['error', 'output', 'result', 'message']) ??
        extractToolResponseText(hookPayload.output) ??
        extractToolResponseText(hookPayload.result)
      if (responseText) {
        update.lastAssistantMessage = responseText
        update.lastAssistantMessageIsToolOutput = true
      }
    }
    return update
  }
  return {}
}
