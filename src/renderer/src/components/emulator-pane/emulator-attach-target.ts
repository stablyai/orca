import type { EmulatorPaneSession, SimulatorDeviceRow } from './emulator-pane-types'

type EmulatorAttachResult = { attached?: boolean; info?: EmulatorPaneSession['info'] }

// An emulator's adb serial dies with it; once the host no longer finds it, its AVD name boots it again.
export async function attachWithAvdFallback(
  devices: SimulatorDeviceRow[],
  target: string | undefined,
  onRetarget: (device: string) => void,
  attachTo: (device: string | undefined) => Promise<EmulatorAttachResult>
): Promise<EmulatorAttachResult> {
  try {
    return await attachTo(target)
  } catch (error) {
    const avdName = devices.find((d) => d.udid === target && d.runtime === 'emulator')?.name
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (!avdName || avdName === target || code !== 'emulator_device_not_found') {
      throw error
    }
    onRetarget(avdName)
    return attachTo(avdName)
  }
}
