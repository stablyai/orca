import { describe, expect, it } from 'vitest'
import type { RoomDelivery, RoomMessage } from '../../../../shared/rooms'
import { getRoomContinueDeliveryIds } from './room-composer-continue-deliveries'
import { roomComposerRunMode } from './room-composer-run-mode'
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
