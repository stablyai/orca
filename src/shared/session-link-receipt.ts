import type { SessionLinkSnapshot } from './session-link'

export function sessionLinkSendReceipt(snapshot: SessionLinkSnapshot, operationId: string) {
  const events = snapshot.events.filter((event) => event.requestId === operationId)
  const delivered = events.length > 0 && events.every((event) => event.state === 'accepted')
  return {
    linkState: snapshot.link.state,
    pauseReason: snapshot.link.reason,
    delivered,
    messages: events.map((event) => ({
      id: event.id,
      recipient: event.recipient,
      state: event.state
    })),
    guidance: events.some((event) => event.kind === 'owner-request')
      ? 'The question is recorded for the owner. The link is paused until the owner answers and continues it. Finish this turn; do not claim the partner received it.'
      : delivered
        ? 'Accepted by the partner chat. This confirms receipt, not a reply, task completion or owner approval.'
        : snapshot.link.state === 'paused'
          ? 'The link is paused. Queued messages have not been delivered. Report the pause reason; do not claim the partner received this message.'
          : 'Queued or sending is not delivered. Only accepted confirms receipt by the partner chat; it does not confirm a reply or task completion.'
  }
}
