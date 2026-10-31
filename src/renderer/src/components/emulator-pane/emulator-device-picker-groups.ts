import type { SimulatorDeviceRow } from './emulator-pane-types'

export function groupEmulatorDevices(devices: SimulatorDeviceRow[], selected: string | null) {
  const used: SimulatorDeviceRow[] = []
  const other: SimulatorDeviceRow[] = []
  const unavailable: SimulatorDeviceRow[] = []
  for (const device of devices) {
    if (device.isAvailable === false) {
      unavailable.push(device)
    } else if (
      device.udid === selected ||
      device.state === 'Booted' ||
      device.state === 'Booting' ||
      device.lastUsedAt
    ) {
      used.push(device)
    } else {
      other.push(device)
    }
  }
  return { used, other, unavailable }
}

export function emulatorDeviceDescription(device: SimulatorDeviceRow): string {
  const ios = device.runtime?.match(/SimRuntime\.(iOS|tvOS|watchOS|visionOS)-([\d-]+)/)
  if (ios) {
    return `${ios[1]} ${ios[2].replaceAll('-', '.')}`
  }
  if (
    device.backend === 'android' ||
    ['avd', 'emulator', 'device'].includes(device.runtime ?? '')
  ) {
    return [
      device.osVersion ? `Android ${device.osVersion}` : 'Android',
      device.apiLevel ? `API ${device.apiLevel}` : ''
    ]
      .filter(Boolean)
      .join(' · ')
  }
  return device.runtime ?? (device.backend === 'ios' ? 'iOS' : '')
}
