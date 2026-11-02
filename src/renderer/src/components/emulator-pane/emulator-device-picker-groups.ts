import { simulatorRuntimeLabel } from '@/lib/simulator-runtime-label'
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
  const runtimeLabel = simulatorRuntimeLabel(device.runtime)
  if (runtimeLabel) {
    return runtimeLabel
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
