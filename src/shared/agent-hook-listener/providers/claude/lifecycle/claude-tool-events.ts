import type { ParsedAgentStatusPayload } from '../../../../agent-status/contracts/agent-status-types'
import { readFirstString } from '../../../interactive-tool'
import type { HookListenerState } from '../../../listener-state'
import { buildClaudeCachedLeadStatusPayload } from './claude-lifecycle-events'
import { resolveClaudePaneStatus } from './claude-pane-hold-evidence'
import { setClaudeMainAgentTurnState } from './claude-roster-state'
import { buildClaudeStatusPayload } from './claude-status-build'

// Covers direct plugin calls and plugin agent calls (toolu_plugin_agent_); Claude Code makes both for a plugin.
const CLAUDE_PLUGIN_TOOL_USE_ID_PREFIX = 'toolu_plugin_'

export function isClaudeToolEvent(eventName: unknown): boolean {
  return (
    eventName === 'PreToolUse' || eventName === 'PostToolUse' || eventName === 'PostToolUseFailure'
  )
}

export function reportedClaudeStateName(
  eventName: unknown,
  isAskUserQuestion: boolean,
  isTurnBoundary: boolean,
  isManualCompactCompletion: boolean
): 'working' | 'waiting' | 'done' | null {
  if (
    eventName === 'UserPromptSubmit' ||
    eventName === 'PostToolUse' ||
    eventName === 'PostToolUseFailure' ||
    (eventName === 'PreToolUse' && !isAskUserQuestion)
  ) {
    return 'working'
  }
  if (eventName === 'PermissionRequest' || eventName === 'Elicitation' || isAskUserQuestion) {
    return 'waiting'
  }
  return isTurnBoundary || isManualCompactCompletion ? 'done' : null
}

export function isClaudePluginToolUseId(toolUseId: string | undefined): boolean {
  return toolUseId?.startsWith(CLAUDE_PLUGIN_TOOL_USE_ID_PREFIX) === true
}

/** A tool call a plugin made, which Claude can run outside the lead's turn (#43998). */
export function isClaudePluginToolCall(hookPayload: Record<string, unknown>): boolean {
  return isClaudePluginToolUseId(readFirstString(hookPayload, ['tool_use_id', 'toolUseId']))
}

/** Handles a plugin call's tool hook so post-Stop plugin activity never reopens a finished turn or invents work. */
export function restatePluginToolCall(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  isAskUserQuestion: boolean
): { payload: ParsedAgentStatusPayload | null } | null {
  if (!isClaudeToolEvent(eventName) || !isClaudePluginToolCall(hookPayload) || isAskUserQuestion) {
    return null
  }
  const lead = state.claudeLeadStateByPaneKey.get(paneKey)
  if (lead?.state !== 'waiting') {
    // Even with no cached lead (null payload), never fall through and invent a working turn.
    return { payload: buildClaudeCachedLeadStatusPayload(state, eventName, paneKey, hookPayload) }
  }
  if (!isClaudePluginToolUseId(lead.waitingToolUseId)) {
    return null
  }
  const eventToolUseId = readFirstString(hookPayload, ['tool_use_id', 'toolUseId'])
  if (
    (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') &&
    eventToolUseId !== undefined &&
    eventToolUseId !== lead.waitingToolUseId
  ) {
    // A parallel sibling plugin tool finishing must not clear another plugin tool's wait card.
    return { payload: null }
  }
  const restored = setClaudeMainAgentTurnState(
    state,
    paneKey,
    lead.stateBeforeWait ?? { state: 'done' as const }
  )
  return {
    payload: buildClaudeStatusPayload(state, eventName, promptText, paneKey, hookPayload, {
      ...resolveClaudePaneStatus(state, paneKey, restored),
      updateToolSnapshot: true
    })
  }
}
