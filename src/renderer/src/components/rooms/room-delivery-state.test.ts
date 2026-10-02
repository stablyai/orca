import { roomDeliveryFixture } from '../../../../shared/rooms.test-fixture'
import { describe, expect, it } from 'vitest'

import { isRoomLoopLimitSuppression } from './room-delivery-state'

describe('isRoomLoopLimitSuppression', () => {
  it('excludes deliveries stopped by the user', () => {
    const delivery = roomDeliveryFixture({ state: 'suppressed', error: null })
    expect(isRoomLoopLimitSuppression(delivery)).toBe(true)
    expect(isRoomLoopLimitSuppression({ ...delivery, error: 'room_stopped' })).toBe(false)
  })
})
