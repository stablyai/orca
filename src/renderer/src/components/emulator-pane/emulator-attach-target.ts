import type { EmulatorSelectionRequired } from '../../../../shared/emulator-opening-preferences'
import type { EmulatorPaneSession, SimulatorDeviceRow } from './emulator-pane-types'

type EmulatorAttachResult = {
  attached?: boolean
  info?: EmulatorPaneSession['info']
  selectionRequired?: EmulatorSelectionRequired
}

// An emulator's adb serial dies with it; once the host no longer finds it, its AVD name boots it again.
export async function attachWithAvdFallback<Result extends EmulatorAttachResult>(
  devices: SimulatorDeviceRow[],
  target: string | undefined,
  onRetarget: (device: string) => void,
  attachTo: (device: string | undefined) => Promise<Result>
): Promise<Result> {
  const avdName = devices.find((d) => d.udid === target && d.runtime === 'emulator')?.name
  try {
    const result = await attachTo(target)
    if (!avdName || avdName === target || result.selectionRequired !== 'missing') {
      return result
    }
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (!avdName || avdName === target || code !== 'emulator_device_not_found') {
      throw error
    }
  }
  onRetarget(avdName)
  return attachTo(avdName)
}
