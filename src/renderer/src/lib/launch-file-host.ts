import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { useAppStore } from '@/store'
import {
  describeLaunchHost,
  spawnedWindowsShell,
  type LaunchHost
} from '../../../shared/launch-host'
import { isWebClientLocation } from './web-client-location'
import { localPwshAvailability } from './local-pwsh-availability'

/**
 * Whether a launch lands on a paired Orca: another Orca this client drives, which may be an older
 * build that neither stages a long line nor writes a launch file. Temporary, until paired hosts
 * advertise both.
 */
export function launchHostIsPaired(runtimeEnvironmentId: string | null | undefined): boolean {
  return isWebClientLocation() || isWebRuntimeSessionActive(runtimeEnvironmentId)
}

/** The host facts for a launch this client starts, from the environment it targets. */
export function clientLaunchHost(args: {
  runtimeEnvironmentId: string | null | undefined
  launchPlatform: NodeJS.Platform
  isRemote: boolean
}): LaunchHost {
  const paired = launchHostIsPaired(args.runtimeEnvironmentId)
  const local = !paired && !args.isRemote && args.launchPlatform === 'win32'
  return describeLaunchHost({
    launchPlatform: args.launchPlatform,
    isRemote: args.isRemote,
    hostPlatform: CLIENT_PLATFORM,
    paired,
    // Why this client's settings: a local pane is spawned from them, as its shell is.
    windowsPaneShell: local
      ? spawnedWindowsShell({
          settings: useAppStore.getState().settings,
          pwshAvailable: localPwshAvailability()
        })
      : null
  })
}
