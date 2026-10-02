import { describe, expect, it } from 'vitest'
import { isRoomParticipantSessionControlBusy } from './RoomParticipantSessionControl'

describe('room participant session control availability', () => {
  it('allows sleeping, offline, and failed agents to be woken by a control', () => {
    for (const state of ['sleeping', 'offline', 'error', 'online'] as const) {
      expect(isRoomParticipantSessionControlBusy(state, false)).toBe(false)
    }
    for (const state of ['starting', 'busy'] as const) {
      expect(isRoomParticipantSessionControlBusy(state, false)).toBe(true)
    }
  })
})
