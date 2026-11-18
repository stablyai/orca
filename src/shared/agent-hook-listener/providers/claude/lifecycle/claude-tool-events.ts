import type { ParsedAgentStatusPayload } from '../../../../agent-status/contracts/agent-status-types'
import { readFirstString } from '../../../interactive-tool'
import type { HookListenerState } from '../../../listener-state'
import { buildClaudeCachedLeadStatusPayload } from './claude-lifecycle-events'

// Covers direct plugin calls and plugin agent calls (toolu_plugin_agent_); Claude Code makes both for a plugin.
const CLAUDE_PLUGIN_TOOL_USE_ID_PREFIX = 'toolu_plugin_'

export function isClaudeToolEvent(eventName: unknown): boolean {
  return (
    eventName === 'PreToolUse' || eventName === 'PostToolUse' || eventName === 'PostToolUseFailure'
  )
}

/** Restates the cached lead for a plugin call's tool hook unless it asks the user; while the lead waits, every event flows through. */
export function restatePluginToolCall(
  state: HookListenerState,
  eventName: unknown,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  isAskUserQuestion: boolean
): ParsedAgentStatusPayload | null {
  const toolUseId = readFirstString(hookPayload, ['tool_use_id', 'toolUseId'])
  const lead = state.claudeLeadStateByPaneKey.get(paneKey)
  const isPluginToolActivity =
    isClaudeToolEvent(eventName) &&
    toolUseId?.startsWith(CLAUDE_PLUGIN_TOOL_USE_ID_PREFIX) === true &&
    !isAskUserQuestion &&
    lead?.state !== 'waiting'
  return isPluginToolActivity
    ? buildClaudeCachedLeadStatusPayload(state, eventName, paneKey, hookPayload)
    : null
}
