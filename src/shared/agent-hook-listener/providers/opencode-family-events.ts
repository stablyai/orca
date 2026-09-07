import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'

export function normalizeOpenCodeFamilyEvent(
  source: 'opencode' | 'mimo-code',
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const resetsTurn =
    isNewTurnEvent(source, eventName) ||
    (eventName === 'MessagePart' && hookPayload.role === 'user')
  const stateName =
    eventName === 'SessionBusy' || eventName === 'MessagePart'
      ? 'working'
      : eventName === 'SessionIdle'
        ? 'done'
        : source === 'opencode' && eventName === 'SessionStart'
          ? 'done'
          : eventName === 'PermissionRequest' || eventName === 'AskUserQuestion'
            ? 'waiting'
            : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields(source, eventName, hookPayload),
    {
      resetOnNewTurn: resetsTurn
    }
  )

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: resetsTurn
    }),
    agentType: source,
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    sessionBoundary: source === 'opencode' && eventName === 'SessionStart' ? true : undefined
  })
}
