import { MobileEmulatorAndroidSetupRow } from './MobileEmulatorAndroidSetupRow'
import { MobileEmulatorIosSetupRow } from './MobileEmulatorIosSetupRow'
import type { EmulatorAvailability } from './use-mobile-emulator-availability'

export function MobileEmulatorAvailabilityDetails({
  availability,
  configuredPath,
  onSetAndroidSdkPath,
  onRefresh
}: {
  availability: Pick<EmulatorAvailability, 'platform' | 'ios' | 'serveSim' | 'android'> | null
  configuredPath?: string | null
  onSetAndroidSdkPath: (path: string | null) => Promise<void>
  onRefresh: () => Promise<void>
}): React.JSX.Element | null {
  if (!availability) {
    return null
  }
  const localMacActions = availability.platform === 'darwin' && Boolean(window.api.emulatorSetup)
  const localHostActions = Boolean(window.api.emulatorSetup)
  return (
    <div className="mt-3 divide-y divide-border/40 rounded-md border border-border/50 px-3">
      <MobileEmulatorIosSetupRow
        status={availability.ios}
        helper={availability.serveSim}
        localActionsAvailable={localMacActions}
        onRefresh={onRefresh}
      />
      <MobileEmulatorAndroidSetupRow
        status={availability.android}
        configuredPath={configuredPath}
        onSetSdkPath={onSetAndroidSdkPath}
        localActionsAvailable={localHostActions}
      />
    </div>
  )
}
