import { describe, expect, it, vi } from 'vitest'
import { getDefaultVoiceSettings } from '../../../shared/constants'
import {
  buildAudioCaptureConstraints,
  buildVoiceMicrophoneSelectOptions,
  isMicrophoneDeviceConstraintError,
  listVoiceMicrophoneDevices,
  microphoneDeviceIdFromSelectValue,
  microphoneSelectValueFromDeviceId,
  normalizeMicrophoneDeviceId,
  openMicrophoneCaptureStream,
  SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE
} from './voice-microphone-devices'

describe('normalizeMicrophoneDeviceId', () => {
  it('treats empty and whitespace as system default', () => {
    expect(normalizeMicrophoneDeviceId(null)).toBeNull()
    expect(normalizeMicrophoneDeviceId(undefined)).toBeNull()
    expect(normalizeMicrophoneDeviceId('')).toBeNull()
    expect(normalizeMicrophoneDeviceId('   ')).toBeNull()
  })

  it('preserves non-empty device ids', () => {
    expect(normalizeMicrophoneDeviceId('abc-123')).toBe('abc-123')
  })
})

describe('getDefaultVoiceSettings microphone fields', () => {
  it('defaults microphone selection to system default', () => {
    const voice = getDefaultVoiceSettings()
    expect(voice.microphoneDeviceId).toBeNull()
    expect(voice.microphoneDeviceLabel).toBeNull()
  })
})

describe('buildAudioCaptureConstraints', () => {
  it('omits deviceId for system default', () => {
    expect(buildAudioCaptureConstraints(null)).toEqual({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
  })

  it('pins exact deviceId when a mic is selected', () => {
    expect(buildAudioCaptureConstraints('usb-mic-1')).toEqual({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        deviceId: { exact: 'usb-mic-1' }
      }
    })
  })
})

describe('isMicrophoneDeviceConstraintError', () => {
  it('matches OverconstrainedError and NotFoundError only', () => {
    expect(isMicrophoneDeviceConstraintError(new DOMException('x', 'OverconstrainedError'))).toBe(
      true
    )
    expect(isMicrophoneDeviceConstraintError(new DOMException('x', 'NotFoundError'))).toBe(true)
    expect(isMicrophoneDeviceConstraintError(new DOMException('x', 'NotAllowedError'))).toBe(false)
    expect(isMicrophoneDeviceConstraintError(new Error('boom'))).toBe(false)
    expect(isMicrophoneDeviceConstraintError(null)).toBe(false)
  })
})

describe('openMicrophoneCaptureStream', () => {
  it('opens with preferred device when available', async () => {
    const stream = { id: 'preferred' } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(stream)

    await expect(
      openMicrophoneCaptureStream({
        preferredDeviceId: 'mic-a',
        getUserMedia
      })
    ).resolves.toEqual({
      stream,
      fellBackToDefaultMicrophone: false,
      usedDeviceId: 'mic-a'
    })

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(getUserMedia).toHaveBeenCalledWith(buildAudioCaptureConstraints('mic-a'))
  })

  it('falls back to system default when preferred device is missing', async () => {
    const fallbackStream = { id: 'default' } as unknown as MediaStream
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('gone', 'OverconstrainedError'))
      .mockResolvedValueOnce(fallbackStream)

    await expect(
      openMicrophoneCaptureStream({
        preferredDeviceId: 'missing-mic',
        getUserMedia
      })
    ).resolves.toEqual({
      stream: fallbackStream,
      fellBackToDefaultMicrophone: true,
      usedDeviceId: null
    })

    expect(getUserMedia).toHaveBeenNthCalledWith(1, buildAudioCaptureConstraints('missing-mic'))
    expect(getUserMedia).toHaveBeenNthCalledWith(2, buildAudioCaptureConstraints(null))
  })

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

describe('listVoiceMicrophoneDevices', () => {
  it('keeps audio inputs and fills empty labels', () => {
    expect(
      listVoiceMicrophoneDevices([
        { deviceId: 'out-1', kind: 'audiooutput', label: 'Speakers' },
        { deviceId: 'mic-1', kind: 'audioinput', label: 'Built-in' },
        { deviceId: 'mic-2', kind: 'audioinput', label: '' },
        { deviceId: '', kind: 'audioinput', label: 'Empty id' }
      ])
    ).toEqual([
      { deviceId: 'mic-1', label: 'Built-in' },
      { deviceId: 'mic-2', label: 'Microphone 2' }
    ])
  })
})

describe('microphone select values', () => {
  it('round-trips system default and concrete device ids', () => {
    expect(microphoneSelectValueFromDeviceId(null)).toBe(SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE)
    expect(microphoneDeviceIdFromSelectValue(SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE)).toBeNull()
    expect(microphoneDeviceIdFromSelectValue('usb-1')).toBe('usb-1')
  })
})

describe('buildVoiceMicrophoneSelectOptions', () => {
  it('includes system default and available devices', () => {
    expect(
      buildVoiceMicrophoneSelectOptions({
        devices: [{ deviceId: 'mic-1', label: 'Built-in' }],
        preferredDeviceId: null,
        preferredDeviceLabel: null,
        systemDefaultLabel: 'System default',
        unavailableSuffix: 'unavailable'
      })
    ).toEqual([
      { value: SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE, label: 'System default' },
      { value: 'mic-1', label: 'Built-in' }
    ])
  })

  it('keeps a missing preferred device as an unavailable option', () => {
    expect(
      buildVoiceMicrophoneSelectOptions({
        devices: [{ deviceId: 'mic-1', label: 'Built-in' }],
        preferredDeviceId: 'airpods',
        preferredDeviceLabel: 'AirPods',
        systemDefaultLabel: 'System default',
        unavailableSuffix: 'unavailable'
      })
    ).toEqual([
      { value: SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE, label: 'System default' },
      { value: 'mic-1', label: 'Built-in' },
      {
        value: 'airpods',
        label: 'AirPods (unavailable)',
        unavailable: true
      }
    ])
  })
})
