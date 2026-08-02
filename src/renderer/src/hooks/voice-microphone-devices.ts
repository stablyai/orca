export type VoiceMicrophoneDevice = {
  deviceId: string
  label: string
}

export type VoiceMicrophoneSelectOption = {
  value: string
  label: string
  unavailable?: boolean
}

export type OpenMicrophoneCaptureStreamResult = {
  stream: MediaStream
  fellBackToDefaultMicrophone: boolean
  usedDeviceId: string | null
}

export const SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE = 'system-default'

const BASE_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
}

export function normalizeMicrophoneDeviceId(deviceId: string | null | undefined): string | null {
  if (typeof deviceId !== 'string') {
    return null
  }
  const trimmed = deviceId.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function buildAudioCaptureConstraints(
  deviceId: string | null | undefined
): MediaStreamConstraints {
  const preferredDeviceId = normalizeMicrophoneDeviceId(deviceId)
  if (!preferredDeviceId) {
    return { audio: { ...BASE_AUDIO_CONSTRAINTS } }
  }
  return {
    audio: {
      ...BASE_AUDIO_CONSTRAINTS,
      deviceId: { exact: preferredDeviceId }
    }
  }
}

export function isMicrophoneDeviceConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const name = 'name' in error ? String(error.name) : ''
  // Why: exact deviceId fails as OverconstrainedError; unplugged devices often surface as NotFoundError.
  return name === 'OverconstrainedError' || name === 'NotFoundError'
}

export async function openMicrophoneCaptureStream(args: {
  preferredDeviceId: string | null | undefined
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>
}): Promise<OpenMicrophoneCaptureStreamResult> {
  const preferredDeviceId = normalizeMicrophoneDeviceId(args.preferredDeviceId)
  try {
    const stream = await args.getUserMedia(buildAudioCaptureConstraints(preferredDeviceId))
    return {
      stream,
      fellBackToDefaultMicrophone: false,
      usedDeviceId: preferredDeviceId
    }
  } catch (error) {
    if (!preferredDeviceId || !isMicrophoneDeviceConstraintError(error)) {
      throw error
    }
    const stream = await args.getUserMedia(buildAudioCaptureConstraints(null))
    return {
      stream,
      fellBackToDefaultMicrophone: true,
      usedDeviceId: null
    }
  }
}

export function listVoiceMicrophoneDevices(
  devices: readonly Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>[]
): VoiceMicrophoneDevice[] {
  return devices
    .filter((device) => device.kind === 'audioinput' && device.deviceId.trim().length > 0)
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label.trim() || `Microphone ${index + 1}`
    }))
}

export function microphoneSelectValueFromDeviceId(deviceId: string | null | undefined): string {
  return normalizeMicrophoneDeviceId(deviceId) ?? SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE
}

export function microphoneDeviceIdFromSelectValue(value: string): string | null {
  if (value === SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE) {
    return null
  }
  return normalizeMicrophoneDeviceId(value)
}

export function buildVoiceMicrophoneSelectOptions(args: {
  devices: readonly VoiceMicrophoneDevice[]
  preferredDeviceId: string | null | undefined
  preferredDeviceLabel: string | null | undefined
  systemDefaultLabel: string
  unavailableSuffix: string
}): VoiceMicrophoneSelectOption[] {
  const preferredDeviceId = normalizeMicrophoneDeviceId(args.preferredDeviceId)
  const options: VoiceMicrophoneSelectOption[] = [
    {
      value: SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE,
      label: args.systemDefaultLabel
    },
    ...args.devices.map((device) => ({
      value: device.deviceId,
      label: device.label
    }))
  ]

  if (preferredDeviceId && !args.devices.some((device) => device.deviceId === preferredDeviceId)) {
    const cachedLabel = args.preferredDeviceLabel?.trim()
    options.push({
      value: preferredDeviceId,
      label: `${cachedLabel && cachedLabel.length > 0 ? cachedLabel : preferredDeviceId} (${args.unavailableSuffix})`,
      unavailable: true
    })
  }

  return options
}
