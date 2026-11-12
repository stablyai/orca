import { describe, expect, it, vi } from 'vitest'

import { openMicrophoneCaptureStream, resolveMicrophoneDevice } from './microphone-devices'

describe('resolveMicrophoneDevice', () => {
  const devices = [
    { deviceId: 'mic-1', label: 'Built-in' },
    { deviceId: 'mic-2', label: 'AirPods' }
  ]

  it('matches by id first', () => {
    expect(
      resolveMicrophoneDevice({
        devices,
        preferredDeviceId: 'mic-2',
        preferredDeviceLabel: 'Built-in'
      })
    ).toEqual({ deviceId: 'mic-2', kind: 'exact' })
  })

  it('heals a re-salted id via a unique label match', () => {
    expect(
      resolveMicrophoneDevice({
        devices,
        preferredDeviceId: 'stale-id',
        preferredDeviceLabel: '  airpods  '
      })
    ).toEqual({ deviceId: 'mic-2', kind: 'relabeled' })
  })

  it('refuses to guess between duplicate labels', () => {
    expect(
      resolveMicrophoneDevice({
        devices: [
          { deviceId: 'a', label: 'Yeti' },
          { deviceId: 'b', label: 'Yeti' }
        ],
        preferredDeviceId: 'stale-id',
        preferredDeviceLabel: 'Yeti'
      })
    ).toEqual({ deviceId: null, kind: 'missing' })
  })

  it('does not treat an unreadable list as a missing device', () => {
    expect(
      resolveMicrophoneDevice({
        devices: null,
        preferredDeviceId: 'mic-9',
        preferredDeviceLabel: null
      })
    ).toEqual({ deviceId: 'mic-9', kind: 'unknown' })
    expect(
      resolveMicrophoneDevice({
        devices: [],
        preferredDeviceId: 'mic-9',
        preferredDeviceLabel: null
      })
    ).toEqual({ deviceId: 'mic-9', kind: 'unknown' })
  })
})

describe('openMicrophoneCaptureStream', () => {
  it('does not fall back on permission errors', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'))

    await expect(
      openMicrophoneCaptureStream({
        preferredDeviceId: 'mic-a',
        getUserMedia
      })
    ).rejects.toMatchObject({ name: 'NotAllowedError' })

    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })
})
