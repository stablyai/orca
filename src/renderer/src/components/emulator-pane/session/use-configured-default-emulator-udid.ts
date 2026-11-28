import { useAppStore } from '@/store/index'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/workspace/ownership/resolve-owner'
import { getEmulatorOpeningMode } from '../../../../../shared/emulator/emulator-opening-preferences'

/** The device Settings opens by default. It names one of this desktop's simulators, so a paired
 *  server's workspace has none here; that server applies its own setting. The owner is looked up
 *  only when a specific device is set. */
export function useConfiguredDefaultEmulatorUdid(worktreeId: string): string | null {
  return useAppStore((state) =>
    state.settings &&
    getEmulatorOpeningMode(state.settings) === 'specific' &&
    runtimeEnvironmentIdUnlessTwin(state, worktreeId) === null
      ? (state.settings.mobileEmulatorDefaultDeviceUdid ?? null)
      : null
  )
}
