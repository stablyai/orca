import { describe, expect, it } from 'vitest'
import type { RoomDelivery, RoomMessage } from '../../../../shared/rooms'
import { getRoomContinueDeliveryIds } from './RoomComposer'
import { getRoomDictationUnavailableReason } from './RoomDictationButton'

describe('room loop continuation', () => {
  it('targets only the newest suppressed chain', () => {
    const messages = [
      { id: 'old', sequence: 4 },
      { id: 'latest', sequence: 9 }
    ] as RoomMessage[]
    const deliveries = [
      { id: 'old-delivery', messageId: 'old', state: 'suppressed' },
      { id: 'beta-delivery', messageId: 'latest', state: 'suppressed' },
      { id: 'gamma-delivery', messageId: 'latest', state: 'suppressed' }
    ] as RoomDelivery[]

    expect(getRoomContinueDeliveryIds(messages, deliveries)).toEqual([
      'beta-delivery',
      'gamma-delivery'
    ])
  })
})

describe('room dictation availability', () => {
  it('disables only unconfigured or denied dictation', () => {
    expect(
      getRoomDictationUnavailableReason({
        enabled: false,
        modelId: null,
        microphonePermission: 'not-determined'
      })
    ).toBe('configure')
    expect(
      getRoomDictationUnavailableReason({
        enabled: true,
        modelId: 'whisper',
        microphonePermission: 'denied'
      })
    ).toBe('permission')
    expect(
      getRoomDictationUnavailableReason({
        enabled: true,
        modelId: 'whisper',
        microphonePermission: 'granted'
      })
    ).toBeNull()
  })
})
