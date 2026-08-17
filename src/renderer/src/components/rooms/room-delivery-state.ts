import type { RoomDelivery } from '../../../../shared/rooms'

export function isRoomDeliveryActive(delivery: RoomDelivery): boolean {
  return (
    delivery.state === 'delivering' || (delivery.state === 'delivered' && !delivery.respondedAt)
  )
}

export function isRoomLoopLimitSuppression(delivery: RoomDelivery): boolean {
  return delivery.state === 'suppressed' && delivery.error === null
}
