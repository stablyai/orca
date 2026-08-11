export type VoiceMicrophoneDevice = {
  deviceId: string
  label: string
}

export type VoiceMicrophoneSelectOption = {
  value: string
  label: string
  unavailable?: boolean
}

export type MicrophoneResolutionKind =
  | 'system-default'
  | 'exact'
  | 'relabeled'
  | 'missing'
  | 'unknown'

export type MicrophoneResolution = {
  deviceId: string | null
  kind: MicrophoneResolutionKind
}

export type OpenMicrophoneCaptureStreamResult = {
  stream: MediaStream
  fellBackToDefaultMicrophone: boolean
  usedDeviceId: string | null
}

export type EnumeratedDevice = Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>

export const SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE = 'system-default'

// Why: Chromium synthesizes these ids as aliases for whatever the OS default is,
// so pinning one behaves exactly like "system default" and defeats the setting.
const AGGREGATE_DEVICE_IDS = new Set(['default', 'communications'])

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
  if (trimmed.length === 0) {
    return null
  }
  return AGGREGATE_DEVICE_IDS.has(trimmed) ? null : trimmed
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

export function listVoiceMicrophoneDevices(
  devices: readonly EnumeratedDevice[]
): VoiceMicrophoneDevice[] {
  return devices
    .filter(
      (device) =>
        device.kind === 'audioinput' && normalizeMicrophoneDeviceId(device.deviceId) !== null
    )
    .map((device, index) => ({
      deviceId: device.deviceId.trim(),
      label: device.label.trim() || `Microphone ${index + 1}`
    }))
}

function findSoleDeviceByLabel(
  devices: readonly VoiceMicrophoneDevice[],
  label: string | null | undefined
): VoiceMicrophoneDevice | null {
  const wanted = label?.trim().toLowerCase()
  if (!wanted) {
    return null
  }
  const matches = devices.filter((device) => device.label.trim().toLowerCase() === wanted)
  // Why: identical labels (two of the same headset) give no basis to pick one.
  return matches.length === 1 ? (matches[0] ?? null) : null
}

/**
 * Resolves a stored preference against the live device list. Pass `devices: null`
 * when the list could not be read — that is not evidence the device is gone.
 */
export function resolveMicrophoneDevice(args: {
  devices: readonly VoiceMicrophoneDevice[] | null
  preferredDeviceId: string | null | undefined
  preferredDeviceLabel: string | null | undefined
}): MicrophoneResolution {
  const preferredDeviceId = normalizeMicrophoneDeviceId(args.preferredDeviceId)
  if (!preferredDeviceId) {
    return { deviceId: null, kind: 'system-default' }
  }
  // Why: before mic permission, enumeration returns only blank placeholders, so an
  // empty list means "cannot tell yet" rather than "unplugged".
  if (!args.devices || args.devices.length === 0) {
    return { deviceId: preferredDeviceId, kind: 'unknown' }
  }
  if (args.devices.some((device) => device.deviceId === preferredDeviceId)) {
    return { deviceId: preferredDeviceId, kind: 'exact' }
  }
  // Why: Chromium re-salts device ids per profile+origin, so a surviving label match
  // heals a preference whose id rotated instead of stranding it forever.
  const relabeled = findSoleDeviceByLabel(args.devices, args.preferredDeviceLabel)
  if (relabeled) {
    return { deviceId: relabeled.deviceId, kind: 'relabeled' }
  }
  return { deviceId: null, kind: 'missing' }
}

async function enumerateMicrophonesOrNull(
  enumerateDevices: (() => Promise<readonly EnumeratedDevice[]>) | undefined
): Promise<VoiceMicrophoneDevice[] | null> {
  if (!enumerateDevices) {
    return null
  }
  try {
    return listVoiceMicrophoneDevices(await enumerateDevices())
  } catch {
    return null
  }
}

export async function openMicrophoneCaptureStream(args: {
  preferredDeviceId: string | null | undefined
  preferredDeviceLabel?: string | null
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  enumerateDevices?: () => Promise<readonly EnumeratedDevice[]>
}): Promise<OpenMicrophoneCaptureStreamResult> {
  const preferredDeviceId = normalizeMicrophoneDeviceId(args.preferredDeviceId)
  if (!preferredDeviceId) {
    return {
      stream: await args.getUserMedia(buildAudioCaptureConstraints(null)),
      fellBackToDefaultMicrophone: false,
      usedDeviceId: null
    }
  }

  const resolution = resolveMicrophoneDevice({
    devices: await enumerateMicrophonesOrNull(args.enumerateDevices),
    preferredDeviceId,
    preferredDeviceLabel: args.preferredDeviceLabel
  })

  // Why: enumeration is a cheap cached lookup, so a known-missing device skips the
  // failed getUserMedia round trip that would otherwise clip the first words.
  if (resolution.kind === 'missing') {
    return {
      stream: await args.getUserMedia(buildAudioCaptureConstraints(null)),
      fellBackToDefaultMicrophone: true,
      usedDeviceId: null
    }
  }

  const targetDeviceId = resolution.deviceId ?? preferredDeviceId
  try {
    const stream = await args.getUserMedia(buildAudioCaptureConstraints(targetDeviceId))
    return { stream, fellBackToDefaultMicrophone: false, usedDeviceId: targetDeviceId }
  } catch (error) {
    // Why: still needed — the device can vanish between enumeration and capture.
    if (!isMicrophoneDeviceConstraintError(error)) {
      throw error
    }
    return {
      stream: await args.getUserMedia(buildAudioCaptureConstraints(null)),
      fellBackToDefaultMicrophone: true,
      usedDeviceId: null
    }
  }
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
  /** false until enumeration has produced a usable list */
  devicesKnown: boolean
  preferredDeviceId: string | null | undefined
  preferredDeviceLabel: string | null | undefined
  systemDefaultLabel: string
  unavailableSuffix: string
}): { options: VoiceMicrophoneSelectOption[]; selectedValue: string } {
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

  const resolution = resolveMicrophoneDevice({
    devices: args.devicesKnown ? args.devices : null,
    preferredDeviceId: args.preferredDeviceId,
    preferredDeviceLabel: args.preferredDeviceLabel
  })

  if (resolution.kind === 'system-default') {
    return { options, selectedValue: SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE }
  }
  if (resolution.kind === 'exact' || resolution.kind === 'relabeled') {
    return { options, selectedValue: resolution.deviceId ?? SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE }
  }

  const preferredDeviceId = normalizeMicrophoneDeviceId(args.preferredDeviceId)
  if (!preferredDeviceId) {
    return { options, selectedValue: SYSTEM_DEFAULT_MICROPHONE_SELECT_VALUE }
  }
  const cachedLabel = args.preferredDeviceLabel?.trim()
  const baseLabel = cachedLabel && cachedLabel.length > 0 ? cachedLabel : preferredDeviceId
  // Why: only call it unavailable once we have actually seen the device list —
  // an un-enumerated list would otherwise flag every mic as missing.
  options.push(
    resolution.kind === 'missing'
      ? {
          value: preferredDeviceId,
          label: `${baseLabel} (${args.unavailableSuffix})`,
          unavailable: true
        }
      : { value: preferredDeviceId, label: baseLabel }
  )
  return { options, selectedValue: preferredDeviceId }
}
