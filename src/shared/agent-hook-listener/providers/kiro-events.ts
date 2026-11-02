import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'

/** Agent-config Kiro hooks use Claude-shaped fields without permission/notification events; approval pauses remain working. Subagents have their own config/hooks, not the lead's. */
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
    // V3 fires SessionStart lazily, just before the first prompt; done would flash idle mid-turn.
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
