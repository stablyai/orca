import type { ToolSnapshot } from '../listener-event'
import {
  deriveFallbackToolInputPreview,
  deriveToolInputPreview,
  hasOwnField,
  readString,
  toolUpdate
} from '../tool-input-preview'

/** Only request_permission waits on a person (resolved via jcode permissions); other safety decisions stay in-model/tool. Match exactly to avoid widening human waits. */
export function isJcodeUserInputTool(toolName: string | undefined): boolean {
  return toolName === 'request_permission'
}

/** jcode's `tool_input` field is the tool's argument JSON as a string. */
function parseJcodeToolInput(hookPayload: Record<string, unknown>): unknown {
  const raw = readString(hookPayload, 'tool_input')
  if (raw === undefined) {
    return undefined
  }
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** The one field of a jcode tool input this module reads directly. */
type JcodeToolIntent = { intent?: unknown }

function hasIntentField(toolInput: unknown): toolInput is JcodeToolIntent {
  return typeof toolInput === 'object' && toolInput !== null && 'intent' in toolInput
}

// Use model-filled intent when tool-specific path/command fields are absent.
function readJcodeIntent(toolInput: unknown): string | undefined {
  if (!hasIntentField(toolInput)) {
    return undefined
  }
  const { intent } = toolInput
  return typeof intent === 'string' && intent.trim().length > 0 ? intent : undefined
}

export function extractJcodeToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (eventName === 'pre_tool') {
    const toolName = readString(hookPayload, 'tool_name')
    const toolInput = parseJcodeToolInput(hookPayload)
    const preview =
      deriveToolInputPreview(toolName, toolInput) ??
      readJcodeIntent(toolInput) ??
      deriveFallbackToolInputPreview(toolInput)
    return toolUpdate(
      {
        toolName,
        toolInput: preview,
        // Keep the full question input only on its own event; never inherit answered cards.
        interactivePrompt:
          isJcodeUserInputTool(toolName) && toolInput !== undefined
            ? JSON.stringify(toolInput)
            : undefined
      },
      { hasToolInputField: hasOwnField(hookPayload, 'tool_input') }
    )
  }
  if (eventName === 'post_tool') {
    const toolName = readString(hookPayload, 'tool_name')
    // post_tool omits input; preserve the matching pre_tool preview.
    return toolUpdate({ toolName, toolInput: undefined }, { hasToolInputField: false })
  }
  if (eventName === 'turn_end') {
    // Keep finished-turn detail for notifications; turn_start clears tools for the next turn.
    const message =
      readString(hookPayload, 'last_assistant_text') ??
      readString(hookPayload, 'last_assistant_message')
    return message ? { lastAssistantMessage: message } : {}
  }
  return {}
}
