import { continueMainAgentStatus } from '../../agent-lead-status-fold'
import {
  normalizeAgentStatusPayload,
  type AgentMainAgentStatus,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { producerCacheKey, producerPreviousStatus, type HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'

export function normalizeOpenCodeFamilyEvent(
  source: 'opencode' | 'opencode2' | 'mimo-code',
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  previousMainAgent?: AgentMainAgentStatus
): ParsedAgentStatusPayload | null {
  const cacheKey = producerCacheKey(paneKey, source)
  const resetsTurn =
    isNewTurnEvent(source, eventName) ||
    (eventName === 'MessagePart' && hookPayload.role === 'user')
  const stateName =
    eventName === 'SessionBusy' || eventName === 'MessagePart'
      ? 'working'
      : eventName === 'SessionIdle'
        ? 'done'
        : (source === 'opencode' || source === 'opencode2') && eventName === 'SessionStart'
          ? 'done'
          : eventName === 'PermissionRequest' || eventName === 'AskUserQuestion'
            ? 'waiting'
            : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    cacheKey,
    extractToolFields(source, eventName, hookPayload),
    {
      resetOnNewTurn: resetsTurn
    }
  )

  const rootState = hookPayload.root_state
  const errorName = hookPayload.root_turn_error_name
  const mainAgent =
    (source === 'opencode' || source === 'opencode2') &&
    (rootState === 'working' || rootState === 'waiting' || rootState === 'done')
      ? continueMainAgentStatus(
          eventName === 'SessionStart'
            ? undefined
            : (previousMainAgent ??
                producerPreviousStatus(state, paneKey, source)?.payload.mainAgent),
          {
            state: rootState,
            outcome:
              rootState === 'done' && typeof errorName === 'string' && errorName
                ? errorName === 'MessageAbortedError'
                  ? 'cancellation'
                  : 'failure'
                : undefined
          },
          Date.now()
        )
      : undefined

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, cacheKey, promptText, {
      resetOnNewTurn: resetsTurn
    }),
    agentType: source,
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    sessionBoundary:
      (source === 'opencode' || source === 'opencode2') && eventName === 'SessionStart'
        ? true
        : undefined,
    ...(mainAgent ? { mainAgent } : {}),
    ...(stateName === 'done' && mainAgent?.outcome === 'cancellation' ? { interrupted: true } : {})
  })
}
