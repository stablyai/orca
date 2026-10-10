import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import {
  clearProducerTurnCacheState,
  type HookListenerState,
  producerCacheKey
} from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'

// Why: Devin uses Claude-compatible payloads but its own lifecycle event set; normalize those event names while keeping Devin attribution.
export function normalizeDevinEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const cacheKey = producerCacheKey(paneKey, 'devin')
  if (eventName === 'SessionStart') {
    // Why: Devin emits SessionStart on idle TUI open/resume; mapping it to 'working' showed a spinner before the user typed, so only UserPromptSubmit/tool activity may create a row.
    clearProducerTurnCacheState(state, cacheKey)
    return null
  }

  const stateName =
    eventName === 'UserPromptSubmit' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse' ||
    eventName === 'PostCompaction'
      ? 'working'
      : eventName === 'PermissionRequest'
        ? 'waiting'
        : eventName === 'Stop' || eventName === 'SessionEnd'
          ? 'done'
          : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    cacheKey,
    extractToolFields('devin', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('devin', eventName) }
  )

  const interrupted =
    eventName === 'Stop' && hookPayload['is_interrupt'] === true ? true : undefined

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, cacheKey, promptText, {
      resetOnNewTurn: isNewTurnEvent('devin', eventName)
    }),
    agentType: 'devin',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    interrupted
  })
}
