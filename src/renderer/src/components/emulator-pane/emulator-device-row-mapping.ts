import type { SimulatorDeviceRow } from './emulator-pane-types'

// Raw shape returned by the unified `emulator.listDevices` RPC (iOS simulators + Android AVDs).
export type RawEmulatorDevice = {
  backend?: 'ios' | 'android'
  id: string
  name: string
  state: string
  detail?: string
  isAvailable?: boolean
}

export function toSimulatorDeviceRows(raw: RawEmulatorDevice[]): SimulatorDeviceRow[] {
  return raw.map((device) => ({
    backend: device.backend,
    name: device.name,
    udid: device.id,
    state: device.state === 'booted' ? 'Booted' : 'Shutdown',
    runtime: device.detail,
    isAvailable: device.isAvailable
  }))
}
