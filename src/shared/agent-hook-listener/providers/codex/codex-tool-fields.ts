import type { ToolSnapshot } from '../../listener-event'
import {
  deriveToolInputPreview,
  hasAnyOwnField,
  readString,
  toolUpdate
} from '../../tool-input-preview'
import { deriveInteractivePrompt } from '../../interactive-tool'

export function extractCodexToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
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
    return toolUpdate(
      {
        toolName,
        toolInput,
        interactivePrompt: deriveInteractivePrompt(toolName, rawInput, eventName)
      },
      { hasToolInputField: hasAnyOwnField(hookPayload, ['tool_input', 'input', 'arguments']) }
    )
  }
  if (eventName === 'Stop') {
    const message = readString(hookPayload, 'last_assistant_message')
    if (message) {
      return { lastAssistantMessage: message }
    }
  }
  return {}
}

/** When only an open question holds the wait, an approval is Codex's own reviewer's, not the user's. */
export function codexToolUpdate(
  eventName: unknown,
  hookPayload: Record<string, unknown>,
  questionHoldsWait?: boolean
): ToolSnapshot {
  const fields = extractCodexToolFields(eventName, hookPayload)
  return questionHoldsWait ? { ...fields, interactivePrompt: undefined } : fields
}
