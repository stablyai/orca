import type { ToolSnapshot } from '../listener-event'
import {
  deriveFallbackToolInputPreview,
  deriveToolInputPreview,
  hasOwnField,
  readString,
  toolUpdate
} from '../tool-input-preview'

/** True for the one jcode tool a *human* answers.
 *
 *  jcode has no per-tool approval prompt — its safety model denies or asks the model
 *  to reflect, both inside the tool. `request_permission`
 *  (crates/jcode-app-core/src/tool/ambient.rs) is the only surface that waits on a
 *  person, resolved out of band with `jcode permissions`. Matched by exact name so a
 *  rename fails loudly here rather than silently widening to unrelated tools. */
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

// Why: every jcode tool schema carries an `intent` string the model fills in with
// what it is doing, which reads better than a bare path when the tool-specific
// key (file_path, command, …) is missing.
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
        // Why: the question card renders the untruncated tool input; only the
        // ask-the-user tool gets one, and resolveToolState never inherits it, so
        // a resolved question cannot linger on the row.
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
    // Why: post_tool reports no input. Keeping `hasToolInputField` false lets the
    // matching pre_tool preview survive the tool's completion instead of blanking.
    return toolUpdate({ toolName, toolInput: undefined }, { hasToolInputField: false })
  }
  if (eventName === 'turn_end') {
    // Why no tool clearing here: `turn_start` already resets the pane's tool cache
    // for the next turn, and the completion notification needs the finished turn's
    // detail (tool or reply) to be worth showing at all — same shape as Claude's Stop.
    const message =
      readString(hookPayload, 'last_assistant_text') ??
      readString(hookPayload, 'last_assistant_message')
    return message ? { lastAssistantMessage: message } : {}
  }
  return {}
}
