import { isReasonixStorageSessionId } from './reasonix-session-paths'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'

export function normalizeReasonixPromptId(value: unknown, sessionId?: string): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const separator = value.lastIndexOf(':')
  const id = value.slice(0, separator)
  const turn = value.slice(separator + 1)
  return isReasonixStorageSessionId(id) &&
    (sessionId === undefined || id === sessionId) &&
    /^[1-9]\d*$/.test(turn) &&
    Number.isSafeInteger(Number(turn))
    ? value
    : undefined
}

export function isStaleReasonixTurn(
  previous: AgentHookEventPayload | undefined,
  incoming: AgentHookEventPayload
): boolean {
  if (
    previous?.source !== 'reasonix' ||
    incoming.source !== 'reasonix' ||
    incoming.hookEventName === 'SessionStart'
  ) {
    return false
  }
  if (previous.providerSession?.id !== incoming.providerSession?.id) {
    return true
  }
  const previousId = normalizeReasonixPromptId(
    previous.providerPromptId,
    previous.providerSession?.id
  )
  const incomingId = normalizeReasonixPromptId(
    incoming.providerPromptId,
    incoming.providerSession?.id
  )
  if (!previousId || !incomingId) {
    return false
  }
  const previousTurn = Number(previousId.split(':').at(-1))
  const incomingTurn = Number(incomingId.split(':').at(-1))
  return (
    incomingTurn < previousTurn ||
    (incomingTurn === previousTurn &&
      previous.payload.state === 'done' &&
      incoming.payload.state !== 'done')
  )
}
