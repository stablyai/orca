import { describe, expect, it, vi } from 'vitest'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import {
  buildAudioCaptureConstraints,
  buildVoiceMicrophoneSelectOptions,
  isMicrophoneDeviceConstraintError,
  listVoiceMicrophoneDevices,
  microphoneDeviceIdFromSelectValue,
  microphoneSelectValueFromDeviceId,
  normalizeMicrophoneDeviceId,
  openMicrophoneCaptureStream,
  resolveMicrophoneDevice,
  SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE
} from './microphone-devices'

describe('normalizeMicrophoneDeviceId', () => {
  it('treats empty and whitespace as system default', () => {
    expect(normalizeMicrophoneDeviceId(null)).toBeNull()
    expect(normalizeMicrophoneDeviceId(undefined)).toBeNull()
    expect(normalizeMicrophoneDeviceId('')).toBeNull()
    expect(normalizeMicrophoneDeviceId('   ')).toBeNull()
  })

  it('treats Chromium aggregate ids as system default', () => {
    expect(normalizeMicrophoneDeviceId('default')).toBeNull()
    expect(normalizeMicrophoneDeviceId('communications')).toBeNull()
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

  it('does not pin the aggregate default id', () => {
    expect(buildAudioCaptureConstraints('default')).toEqual(buildAudioCaptureConstraints(null))
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

describe('resolveMicrophoneDevice', () => {
  const devices = [
    { deviceId: 'mic-1', label: 'Built-in' },
    { deviceId: 'mic-2', label: 'AirPods' }
  ]

  it('reports system default when nothing is preferred', () => {
    expect(
      resolveMicrophoneDevice({ devices, preferredDeviceId: null, preferredDeviceLabel: null })
    ).toEqual({ deviceId: null, kind: 'system-default' })
  })

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

  it('skips the doomed attempt when enumeration proves the device is gone', async () => {
    const fallbackStream = { id: 'default' } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(fallbackStream)
    const enumerateDevices = vi
      .fn()
      .mockResolvedValue([{ deviceId: 'mic-1', kind: 'audioinput', label: 'Built-in' }])

    await expect(
      openMicrophoneCaptureStream({
        preferredDeviceId: 'unplugged',
        preferredDeviceLabel: 'Unplugged Mic',
        getUserMedia,
        enumerateDevices
      })
    ).resolves.toEqual({
      stream: fallbackStream,
      fellBackToDefaultMicrophone: true,
      usedDeviceId: null
    })

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(getUserMedia).toHaveBeenCalledWith(buildAudioCaptureConstraints(null))
  })

  it('captures on the relabeled device after an id rotation', async () => {
    const stream = { id: 'healed' } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(stream)
    const enumerateDevices = vi
      .fn()
      .mockResolvedValue([{ deviceId: 'fresh-id', kind: 'audioinput', label: 'Yeti' }])

    await expect(
      openMicrophoneCaptureStream({
        preferredDeviceId: 'stale-id',
        preferredDeviceLabel: 'Yeti',
        getUserMedia,
        enumerateDevices
      })
    ).resolves.toEqual({
      stream,
      fellBackToDefaultMicrophone: false,
      usedDeviceId: 'fresh-id'
    })

    expect(getUserMedia).toHaveBeenCalledWith(buildAudioCaptureConstraints('fresh-id'))
  })

  it('still falls back when the device vanishes after enumeration', async () => {
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

  it('keeps the preference when the device list cannot be read', async () => {
    const stream = { id: 'preferred' } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(stream)
    const enumerateDevices = vi.fn().mockRejectedValue(new Error('nope'))

    await expect(
      openMicrophoneCaptureStream({
        preferredDeviceId: 'mic-a',
        getUserMedia,
        enumerateDevices
      })
    ).resolves.toMatchObject({ usedDeviceId: 'mic-a', fellBackToDefaultMicrophone: false })
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

  it('drops the Chromium default and communications aliases', () => {
    expect(
      listVoiceMicrophoneDevices([
        { deviceId: 'default', kind: 'audioinput', label: 'Default - Built-in Microphone' },
        { deviceId: 'communications', kind: 'audioinput', label: 'Communications - Headset' },
        { deviceId: 'mic-1', kind: 'audioinput', label: 'Built-in Microphone' }
      ])
    ).toEqual([{ deviceId: 'mic-1', label: 'Built-in Microphone' }])
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
  const labels = { systemDefaultLabel: 'System default', unavailableSuffix: 'unavailable' }

  it('includes system default and available devices', () => {
    expect(
      buildVoiceMicrophoneSelectOptions({
        devices: [{ deviceId: 'mic-1', label: 'Built-in' }],
        devicesKnown: true,
        preferredDeviceId: null,
        preferredDeviceLabel: null,
        ...labels
      })
    ).toEqual({
      options: [
        { value: SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE, label: 'System default' },
        { value: 'mic-1', label: 'Built-in' }
      ],
      selectedValue: SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE
    })
  })

  it('keeps a missing preferred device as an unavailable option', () => {
    expect(
      buildVoiceMicrophoneSelectOptions({
        devices: [{ deviceId: 'mic-1', label: 'Built-in' }],
        devicesKnown: true,
        preferredDeviceId: 'airpods',
        preferredDeviceLabel: 'AirPods',
        ...labels
      })
    ).toEqual({
      options: [
        { value: SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE, label: 'System default' },
        { value: 'mic-1', label: 'Built-in' },
        { value: 'airpods', label: 'AirPods (unavailable)', unavailable: true }
      ],
      selectedValue: 'airpods'
    })
  })

  it('selects the relabeled device instead of showing a ghost row', () => {
    expect(
      buildVoiceMicrophoneSelectOptions({
        devices: [{ deviceId: 'fresh-id', label: 'AirPods' }],
        devicesKnown: true,
        preferredDeviceId: 'stale-id',
        preferredDeviceLabel: 'AirPods',
        ...labels
      })
    ).toEqual({
      options: [
        { value: SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE, label: 'System default' },
        { value: 'fresh-id', label: 'AirPods' }
      ],
      selectedValue: 'fresh-id'
    })
  })

  it('does not label a device unavailable before the list is known', () => {
    expect(
      buildVoiceMicrophoneSelectOptions({
        devices: [],
        devicesKnown: false,
        preferredDeviceId: 'airpods',
        preferredDeviceLabel: 'AirPods',
        ...labels
      })
    ).toEqual({
      options: [
        { value: SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE, label: 'System default' },
        { value: 'airpods', label: 'AirPods' }
      ],
      selectedValue: 'airpods'
    })
  })
})
