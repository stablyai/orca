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

// An emulator's adb serial dies with it; once it is gone, its AVD name boots it again.
// A live serial wins while it is still that AVD: read-only instances can share one AVD name.
export async function emulatorAttachDevice(
  devices: SimulatorDeviceRow[],
  target: string,
  refreshDevices: () => Promise<SimulatorDeviceRow[]>
): Promise<string> {
  const avdName = devices.find((d) => d.udid === target && d.runtime === 'emulator')?.name
  if (!avdName) {
    return target
  }
  const current = await refreshDevices()
  return current.some((d) => d.udid === target && d.name === avdName) ? target : avdName
}
