import { extractAgentProviderSession } from '../../agent-session-resume'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import { continueMainAgentStatus } from '../../agent-lead-status-fold'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'

// Stable 1.39.7 native hooks use camelCase; failed turns repeat the same error on legacy Stop.
export function normalizeReasonixEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const providerSession = extractAgentProviderSession('reasonix', hookPayload)
  if (!providerSession) {
    return null
  }
  const previous = state.lastStatusByPaneKey.get(paneKey)
  const turn = hookPayload.turn
  if (
    eventName !== 'SessionStart' &&
    eventName !== 'SessionEnd' &&
    (typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn <= 0)
  ) {
    return null
  }
  const previousTurn =
    previous?.source === 'reasonix' && previous.providerSession?.id === providerSession.id
      ? Number(previous.providerPromptId?.split(':').at(-1))
      : Number.NaN
  if (
    Number.isSafeInteger(turn) &&
    typeof turn === 'number' &&
    Number.isSafeInteger(previousTurn) &&
    (turn < previousTurn ||
      (turn === previousTurn &&
        previous?.payload.state === 'done' &&
        [
          'UserPromptSubmit',
          'PreToolUse',
          'PostToolUse',
          'PostToolUseFailure',
          'PermissionRequest'
        ].includes(String(eventName))))
  ) {
    return null
  }
  if (
    previous?.source === 'reasonix' &&
    previous.providerSession &&
    previous.providerSession.id !== providerSession.id &&
    eventName !== 'SessionStart'
  ) {
    return null
  }
  let stateName: 'working' | 'waiting' | 'done'
  switch (eventName) {
    case 'SessionStart':
      if (!['startup', 'resume', 'clear'].includes(String(hookPayload.source))) {
        return null
      }
      stateName = 'done'
      break
    case 'UserPromptSubmit':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      stateName = 'working'
      break
    case 'PreToolUse':
      stateName = isAskUserQuestionTool(readString(hookPayload, 'toolName'), 'reasonix')
        ? 'waiting'
        : 'working'
      break
    case 'PermissionRequest':
      stateName = 'waiting'
      break
    case 'Stop':
    case 'StopFailure':
    case 'SessionEnd':
      stateName = 'done'
      break
    default:
      return null
  }
  const resetOnNewTurn = isNewTurnEvent('reasonix', eventName)
  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('reasonix', eventName, hookPayload),
    { resetOnNewTurn }
  )
  const stopped = eventName === 'Stop' || eventName === 'StopFailure'
  const outcome = stopped
    ? hookPayload.isInterrupt === true
      ? ('cancellation' as const)
      : eventName === 'StopFailure' || readString(hookPayload, 'error')
        ? ('failure' as const)
        : undefined
    : undefined
  const settled = eventName === 'SessionEnd' ? previous?.payload.mainAgent : undefined
  return normalizeAgentStatusPayload({
    state: stateName,
    agentType: 'reasonix',
    prompt: resolvePrompt(state, paneKey, promptText, { resetOnNewTurn }),
    ...snapshot,
    sessionBoundary: eventName === 'SessionStart' ? true : undefined,
    interrupted: outcome === 'cancellation' ? true : undefined,
    mainAgent:
      settled ??
      continueMainAgentStatus(
        !resetOnNewTurn &&
          previous?.source === 'reasonix' &&
          previous.providerSession?.id === providerSession.id
          ? previous.payload.mainAgent
          : undefined,
        { state: stateName, ...(outcome ? { outcome } : {}) },
        Date.now()
      )
  })
}
