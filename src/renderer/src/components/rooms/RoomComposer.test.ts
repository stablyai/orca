import { roomMessageFixture, roomDeliveryFixture } from '../../../../shared/rooms.test-fixture'
import { describe, expect, it } from 'vitest'

import { getRoomContinueDeliveryIds } from './room-composer-continue-deliveries'
import { roomComposerRunMode } from './room-composer-run-mode'
import { getRoomDictationUnavailableReason } from './RoomDictationButton'

describe('room loop continuation', () => {
  it('targets only the newest suppressed chain', () => {
    const messages = [
      roomMessageFixture({ id: 'old', sequence: 4 }),
      roomMessageFixture({ id: 'latest', sequence: 9 })
    ]
    const deliveries = [
      roomDeliveryFixture({ id: 'old-delivery', messageId: 'old', state: 'suppressed' }),
      roomDeliveryFixture({ id: 'beta-delivery', messageId: 'latest', state: 'suppressed' }),
      roomDeliveryFixture({ id: 'gamma-delivery', messageId: 'latest', state: 'suppressed' })
    ]

    expect(getRoomContinueDeliveryIds(messages, deliveries)).toEqual([
      'beta-delivery',
      'gamma-delivery'
    ])
  })
})

describe('room composer run mode', () => {
  it('switches between Stop, Play, and Send without hiding an existing draft', () => {
    expect(roomComposerRunMode('active', false)).toBe('stop')
    expect(roomComposerRunMode('active', true)).toBe('stop')
    expect(roomComposerRunMode('stopped', false)).toBe('resume')
    expect(roomComposerRunMode('stopped', true)).toBe('send')
    expect(roomComposerRunMode('idle', false)).toBe('send')
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
