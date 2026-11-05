import { readFirstString } from './interactive-tool'
import type { HookListenerState } from './listener-state'
import { deriveToolInputPreview, readString } from './tool-input-preview'
import { readClaudeBatchSettledRequests } from './claude-settled-permission-requests'

/** The fields that tie a Claude PermissionRequest to the PreToolUse it is asking about. */
export type ClaudeToolRequestFields = {
  toolAgentId?: string
  toolAgentType?: string
  toolName?: string
  toolInput?: string
}

export type ClaudeToolRequest = ClaudeToolRequestFields & { toolUseId: string }

/** PermissionRequest omits tool_use_id; it asks about a PreToolUse with the same owner, tool and input. */
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

// Why a bound: calls Claude never resolves (an interrupt) must not accumulate; extra matches only stop naming.
const MAX_OPEN_TOOL_USES = 32

/** Give a Claude PermissionRequest the tool_use_id of the one open call it asks about, so its wait can be settled by request. */
export function withClaudeToolRequestId(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): Record<string, unknown> {
  const toolUseId = readFirstString(hookPayload, ['tool_use_id', 'toolUseId'])
  const fields = readRequestFields(hookPayload)
  const open = (state.claudeOpenToolUsesByPaneKey.get(paneKey) ?? []).filter((call) =>
    keepsClaudeToolUseOpen(call, eventName, toolUseId, fields.toolAgentId, hookPayload)
  )
  if (eventName === 'PreToolUse' && toolUseId) {
    open.push({ ...fields, toolUseId })
  }
  if (open.length > 0) {
    state.claudeOpenToolUsesByPaneKey.set(paneKey, open.slice(-MAX_OPEN_TOOL_USES))
  } else {
    state.claudeOpenToolUsesByPaneKey.delete(paneKey)
  }
  if (eventName !== 'PermissionRequest' || toolUseId) {
    return hookPayload
  }
  // Parallel calls interleave their hooks, so the request is the open call it matches, never just the latest.
  const matches = open.filter((call) => claudePermissionNamesToolUse(call, fields))
  return matches.length === 1 ? { ...hookPayload, tool_use_id: matches[0].toolUseId } : hookPayload
}

function keepsClaudeToolUseOpen(
  call: ClaudeToolRequest,
  eventName: unknown,
  toolUseId: string | undefined,
  toolAgentId: string | undefined,
  hookPayload: Record<string, unknown>
): boolean {
  if (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') {
    return call.toolUseId !== toolUseId
  }
  if (eventName === 'PostToolBatch') {
    return !readClaudeBatchSettledRequests(hookPayload)?.some(
      (request) => request.toolUseId === call.toolUseId
    )
  }
  // A lead's calls never outlive its turn; background children's can.
  const leadTurnBoundary =
    toolAgentId === undefined &&
    (eventName === 'UserPromptSubmit' || eventName === 'Stop' || eventName === 'StopFailure')
  return !(leadTurnBoundary && call.toolAgentId === undefined) && eventName !== 'SessionStart'
}
