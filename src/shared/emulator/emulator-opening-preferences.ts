export type EmulatorOpeningMode = 'last-used' | 'ask' | 'specific'
export type EmulatorDevicePreference = {
  backend: 'ios' | 'android'
  kind: 'avd' | 'device'
  id: string
  name: string
  lastUsedAt: string
}
export type EmulatorSelectionRequired = 'first-use' | 'ask' | 'missing' | 'unavailable'

export function getEmulatorOpeningMode(settings: {
  mobileEmulatorOpeningMode?: EmulatorOpeningMode
  mobileEmulatorDefaultDeviceUdid?: string | null
}): EmulatorOpeningMode {
  return (
    settings.mobileEmulatorOpeningMode ??
    (settings.mobileEmulatorDefaultDeviceUdid ? 'specific' : 'last-used')
  )
}

export type EmulatorOpeningSettings = {
  mobileEmulatorOpeningMode?: EmulatorOpeningMode
  mobileEmulatorRecentDevices?: EmulatorDevicePreference[]
}
