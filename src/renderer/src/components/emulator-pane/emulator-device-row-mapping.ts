import type { SimulatorDeviceRow } from './emulator-pane-types'

export type RawEmulatorDevice = {
  id: string
  name: string
  backend?: 'ios' | 'android'
  state: string
  detail?: string
  isAvailable?: boolean
  lastUsedAt?: string
  availabilityError?: string
  osVersion?: string
  apiLevel?: string
}

export function toSimulatorDeviceRows(raw: RawEmulatorDevice[]): SimulatorDeviceRow[] {
  return raw.map((device) => ({
    name: device.name,
    backend: device.backend,
    lastUsedAt: device.lastUsedAt,
    availabilityError: device.availabilityError,
    osVersion: device.osVersion,
    apiLevel: device.apiLevel,
    udid: device.id,
    state:
      device.state === 'booted' ? 'Booted' : device.state === 'booting' ? 'Booting' : 'Shutdown',
    runtime: device.detail,
    isAvailable: device.isAvailable
  }))
}
