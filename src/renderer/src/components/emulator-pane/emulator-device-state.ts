import type { SimulatorDeviceRow } from './emulator-pane-types'

export function markSimulatorDeviceState(
  devices: SimulatorDeviceRow[],
  target: string | null | undefined,
  state: string
): SimulatorDeviceRow[] {
  if (!target) {
    return devices
  }

  let changed = false
  const next = devices.map((device) => {
    if (device.udid !== target && device.name !== target) {
      return device
    }
    if (device.state === state) {
      return device
    }
    changed = true
    return { ...device, state }
  })

  return changed ? next : devices
}

export function markSimulatorDeviceBooted(
  devices: SimulatorDeviceRow[],
  target: string | null | undefined
): SimulatorDeviceRow[] {
  return markSimulatorDeviceState(devices, target, 'Booted')
}

export function markSimulatorDeviceShutdown(
  devices: SimulatorDeviceRow[],
  target: string | null | undefined
): SimulatorDeviceRow[] {
  return markSimulatorDeviceState(devices, target, 'Shutdown')
}
