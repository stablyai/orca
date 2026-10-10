import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'

/**
 * Kiro CLI hooks live in each agent config (`~/.kiro/agents/<name>.json`) and fire
 * agentSpawn, userPromptSubmit, preToolUse, postToolUse and stop with a Claude-shaped
 * stdin payload (`session_id`, `cwd`, `prompt`, `tool_name`, `tool_input`,
 * `tool_response`, `assistant_response`). There is no permission or notification event,
 * so an approval pause reads as `working` — the agent is mid-tool, not idle.
 * Subagents run under their own config and do not fire the lead's hooks.
 *
 * The opt-in V3 engine (`--v3`) runs a global standalone hooks file instead and sends the
 * same payload under Claude's PascalCase names, plus SessionEnd and no final reply on Stop.
 */
export function normalizeKiroEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  let stateName: 'working' | 'done'
  switch (eventName) {
    case 'userPromptSubmit':
    case 'preToolUse':
    case 'postToolUse':
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      stateName = 'working'
      break
    case 'agentSpawn':
    case 'stop':
    case 'Stop':
    case 'SessionEnd':
      stateName = 'done'
      break
    // Why: V3 creates its session lazily, so SessionStart lands right before the first
    // UserPromptSubmit; settling the pane to done there would flash it idle mid-turn.
    default:
      return null
  }

  const resetOnNewTurn = isNewTurnEvent('kiro', eventName)
  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('kiro', eventName, hookPayload),
    { resetOnNewTurn }
  )

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, { resetOnNewTurn }),
    agentType: 'kiro',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput
  })
}
