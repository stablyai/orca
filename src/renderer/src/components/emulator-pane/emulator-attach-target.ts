import { pickDefaultDevice, type SimulatorDeviceRow } from './emulator-pane-types'

type ResolveEmulatorAttachTargetArgs = {
  configuredDefaultUdid: string | null
  devices: SimulatorDeviceRow[]
  deviceTarget?: string
  selectedUdid: string | null
}

export function resolveEmulatorAttachTarget({
  configuredDefaultUdid,
  devices,
  deviceTarget,
  selectedUdid
}: ResolveEmulatorAttachTargetArgs): string | undefined {
  if (deviceTarget || selectedUdid || configuredDefaultUdid) {
    return deviceTarget || selectedUdid || configuredDefaultUdid || undefined
  }
  return devices.length > 0 ? pickDefaultDevice(devices)?.udid : undefined
}

// An emulator's adb serial dies with it; its AVD name reattaches a running one or boots it again.
export function emulatorAttachDevice(devices: SimulatorDeviceRow[], target: string): string {
  return devices.find((d) => d.udid === target && d.runtime === 'emulator')?.name ?? target
}
