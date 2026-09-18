import type { ParsedAgentStatusPayload } from '../../agent-status-types'
import { normalizeAgentStatusPayload } from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import { readString } from '../tool-input-preview'

/** Normalize Augment Code's documented hook contract without identifying it as Claude. */
export function normalizeAuggieEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const toolName = readString(hookPayload, 'tool_name')
  const waiting = eventName === 'PreToolUse' && /^(ask[-_ ]?user|question)/i.test(toolName ?? '')
  const stateName =
    eventName === 'SessionStart' || eventName === 'Stop' || eventName === 'SessionEnd'
      ? 'done'
      : eventName === 'PromptSubmit' || eventName === 'PostToolUse' || eventName === 'PreToolUse'
        ? waiting
          ? 'waiting'
          : 'working'
        : null
  if (!stateName) {
    return null
  }
  if (eventName === 'SessionStart') {
    state.lastToolByPaneKey.delete(paneKey)
  }
  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: promptText,
    agentType: 'auggie',
    toolName: toolName ?? undefined,
    interactivePrompt: waiting ? readString(hookPayload, 'message') : undefined,
    sessionBoundary: eventName === 'SessionStart' ? true : undefined,
    lastAssistantMessage:
      eventName === 'Stop'
        ? (readString(hookPayload, 'agentTextResponse') ??
          readString(hookPayload, 'agent_text_response'))
        : undefined
  })
}
