import type { RoomDelivery, RoomMessage } from '../../../../shared/rooms'

export function getRoomContinueDeliveryIds(
  messages: RoomMessage[],
  deliveries: RoomDelivery[]
): string[] {
  const sequences = new Map(messages.map((message) => [message.id, message.sequence]))
  const suppressed = deliveries.filter(
    (delivery) => delivery.state === 'suppressed' && sequences.has(delivery.messageId)
  )
  const latestSequence = Math.max(
    -1,
    ...suppressed.map((delivery) => sequences.get(delivery.messageId)!)
  )
  return [
    ...new Set(
      suppressed
        .filter((delivery) => sequences.get(delivery.messageId) === latestSequence)
        .map((delivery) => delivery.id)
    )
  ]
}
