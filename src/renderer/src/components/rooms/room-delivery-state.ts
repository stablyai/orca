import type { RoomDelivery } from '../../../../shared/rooms'

export function isRoomDeliveryActive(delivery: RoomDelivery): boolean {
  return (
    delivery.state === 'pending' ||
    delivery.state === 'delivering' ||
    (delivery.state === 'delivered' && !delivery.respondedAt)
  )
}
