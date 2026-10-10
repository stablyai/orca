import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { producerCacheKey, producerPreviousStatus, type HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'

export function normalizeCursorEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const cacheKey = producerCacheKey(paneKey, 'cursor')
  // Why: Cursor can emit final response text after `stop`; enrich the completed row, don't resurrect the agent as working.
  const previousStatus = producerPreviousStatus(state, paneKey, 'cursor')?.payload
  const stateName =
    eventName === 'beforeSubmitPrompt' ||
    eventName === 'sessionStart' ||
    eventName === 'preToolUse' ||
    eventName === 'postToolUse' ||
    eventName === 'postToolUseFailure' ||
    // Why: these fire on every shell/MCP invocation (pre-execution gates, not just approval); treat as working to avoid waiting-notification spam.
    eventName === 'beforeShellExecution' ||
    eventName === 'beforeMCPExecution'
      ? 'working'
      : eventName === 'afterAgentResponse'
        ? previousStatus?.state === 'done'
          ? 'done'
          : 'working'
        : eventName === 'stop' || eventName === 'sessionEnd'
          ? 'done'
          : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    cacheKey,
    extractToolFields('cursor', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('cursor', eventName) }
  )

  const interrupted =
    eventName === 'stop' &&
    typeof hookPayload.status === 'string' &&
    hookPayload.status !== 'completed'
      ? true
      : undefined

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, cacheKey, promptText, {
      resetOnNewTurn: isNewTurnEvent('cursor', eventName)
    }),
    agentType: 'cursor',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    interrupted
  })
}
