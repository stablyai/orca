import type { SessionLinkEvent } from './session-link'

export function sessionLinkWaitingFor(
  events: readonly SessionLinkEvent[],
  sessionId: string
): SessionLinkEvent | null {
  const checkpoint = events.findLast(
    (e) =>
      e.actor === sessionId &&
      (e.kind === 'question' || e.kind === 'checkpoint') &&
      e.state !== 'cancelled'
  )
  if (!checkpoint) {
    return null
  }
  return events.some(
    (e) => e.kind === 'reply' && e.replyTo === checkpoint.id && e.state === 'accepted'
  )
    ? null
    : checkpoint
}

export function sessionLinkNextMessage(
  events: readonly SessionLinkEvent[],
  sessionId: string
): SessionLinkEvent | undefined {
  const pending = events.filter(
    (e) =>
      e.kind !== 'control' &&
      e.recipient === sessionId &&
      ['queued', 'dispatching', 'blocked'].includes(e.state)
  )
  const unresolved = pending.find((e) => e.state === 'dispatching' || e.state === 'blocked')
  if (unresolved) {
    return unresolved
  }
  const owner = pending.find((e) => e.actor === 'owner')
  if (owner) {
    return owner
  }
  const waiting = sessionLinkWaitingFor(events, sessionId)
  return pending.find(
    (e) =>
      !waiting ||
      e.kind === 'question' ||
      e.kind === 'checkpoint' ||
      (e.kind === 'reply' && e.replyTo === waiting.id)
  )
}

export function sessionLinkOwnerRequest(
  events: readonly SessionLinkEvent[]
): SessionLinkEvent | null {
  const index = events.findLastIndex((event) => event.kind === 'owner-request')
  return index === -1 ||
    events.slice(index + 1).some((event) => event.actor === 'owner' && event.kind === 'owner-note')
    ? null
    : events[index]
}
