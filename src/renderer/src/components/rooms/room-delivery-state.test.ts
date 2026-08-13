import { describe, expect, it } from 'vitest'
import type { RoomDelivery } from '../../../../shared/rooms'
import { isRoomLoopLimitSuppression } from './room-delivery-state'

describe('isRoomLoopLimitSuppression', () => {
  it('excludes deliveries stopped by the user', () => {
    const delivery = { state: 'suppressed', error: null } as RoomDelivery
    expect(isRoomLoopLimitSuppression(delivery)).toBe(true)
    expect(isRoomLoopLimitSuppression({ ...delivery, error: 'room_stopped' })).toBe(false)
  })
})
