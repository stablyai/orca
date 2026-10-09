import type { ToolSnapshot } from '../listener-event'
import { readLastRovoAssistantText } from '../rovo-transcript'
import { deriveFallbackToolInputPreview, readString, toolUpdate } from '../tool-input-preview'

// Why: Rovo runs these tools while the TUI waits on the person, not on the model.
const ROVO_USER_INPUT_TOOLS = new Set(['ask_user_questions', 'exit_plan_mode'])

export function isRovoUserInputTool(toolName: string | undefined): boolean {
  return toolName !== undefined && ROVO_USER_INPUT_TOOLS.has(toolName)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readAttributes(hookPayload: Record<string, unknown>): Record<string, unknown> {
  return isRecord(hookPayload.attributes) ? hookPayload.attributes : {}
}

/** First entry of `attributes.tool_calls` (on_tool_start) or `attributes.tool_results` (on_tool_end). */
export function readFirstRovoToolEntry(
  hookPayload: Record<string, unknown>,
  key: 'tool_calls' | 'tool_results'
): Record<string, unknown> | undefined {
  const entries = readAttributes(hookPayload)[key]
  const first = Array.isArray(entries) ? entries[0] : undefined
  return isRecord(first) ? first : undefined
}

export function readRovoAttributeString(
  hookPayload: Record<string, unknown>,
  key: string
): string | undefined {
  return readString(readAttributes(hookPayload), key)
}

function deriveRovoToolPreview(toolArgs: unknown): string | undefined {
  if (!isRecord(toolArgs)) {
    return deriveFallbackToolInputPreview(toolArgs)
  }
  const filePaths = toolArgs.file_paths
  const firstFilePath = Array.isArray(filePaths)
    ? filePaths.find((p) => typeof p === 'string')
    : undefined
  // Why: every Rovo tool call carries an `_intent` sentence, the readable last resort.
  return (
    deriveFallbackToolInputPreview(toolArgs) ??
    (typeof firstFilePath === 'string' ? firstFilePath : undefined) ??
    readString(toolArgs, 'content_pattern') ??
    readString(toolArgs, 'path_glob') ??
    readString(toolArgs, '_intent')
  )
}

export function extractRovoToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (eventName === 'on_tool_start') {
    const call = readFirstRovoToolEntry(hookPayload, 'tool_calls')
    if (!call) {
      return {}
    }
    const toolName = readString(call, 'tool_name')
    const toolArgs = call.tool_args
    return toolUpdate(
      {
        toolName,
        toolInput: deriveRovoToolPreview(toolArgs),
        interactivePrompt:
          isRovoUserInputTool(toolName) && toolArgs !== undefined
            ? JSON.stringify(toolArgs)
            : undefined
      },
      { hasToolInputField: Object.hasOwn(call, 'tool_args') }
    )
  }
  if (eventName === 'on_tool_end') {
    const result = readFirstRovoToolEntry(hookPayload, 'tool_results')
    // Why: on_tool_end has no args; leaving hasToolInputField false keeps the start preview.
    return toolUpdate(
      { toolName: result ? readString(result, 'tool_name') : undefined, toolInput: undefined },
      { hasToolInputField: false }
    )
  }
  if (eventName === 'on_complete') {
    const message = readLastRovoAssistantText(hookPayload.transcript_path)
    return message ? { lastAssistantMessage: message } : {}
  }
  return {}
}
