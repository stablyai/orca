import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { producerCacheKey, type HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'

export function normalizeCommandCodeEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const cacheKey = producerCacheKey(paneKey, 'command-code')
  const stateName =
    eventName === 'PreToolUse' || eventName === 'PostToolUse'
      ? 'working'
      : eventName === 'Stop'
        ? 'done'
        : null
  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    cacheKey,
    extractToolFields('command-code', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('command-code', eventName) }
  )

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, cacheKey, promptText, {
      resetOnNewTurn: isNewTurnEvent('command-code', eventName)
    }),
    agentType: 'command-code',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput
  })
}
