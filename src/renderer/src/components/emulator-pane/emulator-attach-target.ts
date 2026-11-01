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

// An emulator's adb serial dies with it; once the host no longer finds it, its AVD name boots it again.
export async function attachWithAvdFallback<T>(
  devices: SimulatorDeviceRow[],
  target: string,
  onRetarget: (device: string) => void,
  attachTo: (device: string) => Promise<T>
): Promise<T> {
  try {
    return await attachTo(target)
  } catch (error) {
    const avdName = devices.find((d) => d.udid === target && d.runtime === 'emulator')?.name
    const notFound = error instanceof Error && 'code' in error
    if (!avdName || avdName === target || !notFound || error.code !== 'emulator_device_not_found') {
      throw error
    }
    onRetarget(avdName)
    return attachTo(avdName)
  }
}
