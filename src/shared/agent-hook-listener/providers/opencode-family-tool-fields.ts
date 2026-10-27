import { capOpenCodeHookText } from '../listener-limits'
import type { ToolSnapshot } from '../listener-event'
import { hasAnyOwnField, hasOwnField, readString, toolUpdate } from '../tool-input-preview'
import {
  deriveInteractivePrompt,
  readFirstString,
  stripHookEnvelopeKeys
} from '../interactive-tool'

/** Resumed sessions emit no SessionStart; explicitly retire permission fields or answered cards persist on later frames. */
const OPENCODE_TOOL_FIELDS_RETIRED: ToolSnapshot = {
  hasToolUpdate: true,
  hasToolInputField: true
}

export function extractOpenCodeToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (eventName === 'MessagePart' && hookPayload.role === 'assistant') {
    const text = readString(hookPayload, 'text')
    if (text) {
      return { ...OPENCODE_TOOL_FIELDS_RETIRED, lastAssistantMessage: capOpenCodeHookText(text) }
    }
  }
  if (eventName === 'AskUserQuestion') {
    // question.asked carries event.properties; remove envelope fields when tool_input is absent.
    const toolInputSource = hasOwnField(hookPayload, 'tool_input')
      ? hookPayload.tool_input
      : stripHookEnvelopeKeys(hookPayload)
    return {
      ...OPENCODE_TOOL_FIELDS_RETIRED,
      interactivePrompt: deriveInteractivePrompt('AskUserQuestion', toolInputSource)
    }
  }
  if (eventName === 'PermissionRequest') {
    // OpenCode1.18.18 tool metadata names command/path/url; omit whole-patch diff so it cannot swamp the row.
    const metadata = hookPayload.metadata
    const metadataInput =
      metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
        ? readFirstString(metadata as Record<string, unknown>, [
            'command',
            'filepath',
            'file_path',
            'path',
            'url'
          ])
        : undefined
    const patterns = Array.isArray(hookPayload.patterns)
      ? hookPayload.patterns.filter(
          (pattern): pattern is string => typeof pattern === 'string' && pattern.length > 0
        )
      : []
    const toolName = readString(hookPayload, 'permission')
    const toolInput = metadataInput ?? (patterns.length > 0 ? patterns.join(', ') : undefined)
    return toolUpdate(
      {
        toolName,
        toolInput,
        interactivePrompt: deriveInteractivePrompt(toolName, { command: toolInput }, eventName)
      },
      { hasToolInputField: hasAnyOwnField(hookPayload, ['metadata', 'patterns']) }
    )
  }
  return OPENCODE_TOOL_FIELDS_RETIRED
}
