import type { SimulatorDeviceRow } from './emulator-pane-types'

export type RawEmulatorDevice = {
  id: string
  name: string
  state: string
  detail?: string
  isAvailable?: boolean
}

export function toSimulatorDeviceRows(raw: RawEmulatorDevice[]): SimulatorDeviceRow[] {
  return raw.map((device) => ({
    name: device.name,
    udid: device.id,
    state: device.state === 'booted' ? 'Booted' : 'Shutdown',
    runtime: device.detail,
    isAvailable: device.isAvailable
  }))
}
