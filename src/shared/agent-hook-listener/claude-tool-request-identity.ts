import { readFirstString } from './interactive-tool'
import type { HookListenerState } from './listener-state'
import { deriveToolInputPreview, readString } from './tool-input-preview'

/** The fields that tie a Claude PermissionRequest to the PreToolUse it is asking about. */
export type ClaudeToolRequestFields = {
  toolAgentId?: string
  toolAgentType?: string
  toolName?: string
  toolInput?: string
}

export type ClaudeToolRequest = ClaudeToolRequestFields & { toolUseId: string }

/** PermissionRequest omits tool_use_id; it names the PreToolUse just before it with the same owner, tool and input. */
export function claudePermissionNamesToolUse(
  toolUse: ClaudeToolRequestFields,
  permission: ClaudeToolRequestFields
): boolean {
  return (
    toolUse.toolAgentId === permission.toolAgentId &&
    toolUse.toolAgentType === permission.toolAgentType &&
    toolUse.toolName !== undefined &&
    toolUse.toolName === permission.toolName &&
    toolUse.toolInput === permission.toolInput
  )
}

function readRequestFields(hookPayload: Record<string, unknown>): ClaudeToolRequestFields {
  const toolName = readString(hookPayload, 'tool_name')
  return {
    toolAgentId: readFirstString(hookPayload, ['agent_id', 'agentId']),
    toolAgentType: readString(hookPayload, 'agent_type'),
    toolName,
    toolInput: deriveToolInputPreview(toolName, hookPayload.tool_input)
  }
}

/** Give a Claude PermissionRequest the tool_use_id of the call it asks about, so its wait can be settled by request. */
export function withClaudeToolRequestId(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): Record<string, unknown> {
  const previous = state.claudeLastToolUseByPaneKey.get(paneKey)
  state.claudeLastToolUseByPaneKey.delete(paneKey)
  const toolUseId = readFirstString(hookPayload, ['tool_use_id', 'toolUseId'])
  if (eventName === 'PreToolUse' && toolUseId) {
    state.claudeLastToolUseByPaneKey.set(paneKey, {
      ...readRequestFields(hookPayload),
      toolUseId
    })
    return hookPayload
  }
  if (
    eventName !== 'PermissionRequest' ||
    toolUseId ||
    !previous ||
    !claudePermissionNamesToolUse(previous, readRequestFields(hookPayload))
  ) {
    return hookPayload
  }
  return { ...hookPayload, tool_use_id: previous.toolUseId }
}
