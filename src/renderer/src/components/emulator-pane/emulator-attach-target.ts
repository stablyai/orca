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
