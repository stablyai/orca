import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { clearPaneTurnCacheState, type HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'

// Why: jcode's permission/ask surface is tool-driven; token-normalize the name
// (like Kimi's AskUserQuestion check) so renamed or spaced variants still count.
export function isJcodeUserInputTool(toolName: string | undefined): boolean {
  const normalized = toolName?.replaceAll(/[^a-z0-9]/gi, '').toLowerCase() ?? ''
  return (
    normalized.includes('ask') ||
    normalized.includes('question') ||
    normalized.includes('permission') ||
    normalized.includes('approval') ||
    normalized.includes('confirm')
  )
}

export function normalizeJcodeEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (eventName === 'session_start') {
    // Why: jcode fires session_start on idle TUI open/attach/resume; mapping it
    // to 'working' would show a spinner before the user typed (mirrors Devin).
    clearPaneTurnCacheState(state, paneKey)
    return null
  }

  const toolName = readString(hookPayload, 'tool_name')
  const stateName =
    eventName === 'post_tool' && isJcodeUserInputTool(toolName)
      ? 'waiting'
      : eventName === 'post_tool'
        ? 'working'
        : eventName === 'turn_end' || eventName === 'session_end'
          ? 'done'
          : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('jcode', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('jcode', eventName) }
  )

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: isNewTurnEvent('jcode', eventName)
    }),
    agentType: 'jcode',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    lastAssistantMessage: snapshot.lastAssistantMessage
  })
}
