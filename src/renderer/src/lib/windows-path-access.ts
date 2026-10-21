import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { windowsPathAccess, type WindowsPathAccess } from '../../../shared/windows-path-access'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { isWebClientLocation } from './web-client-location'

type WslEnvironmentSource = readonly Pick<PublicKnownRuntimeEnvironment, 'id' | 'orcadDeployment'>[]

// Why an accessor, not an import of the store: path guards load from inside store slices.
let readKnownEnvironments: () => WslEnvironmentSource = () => []

export function registerWindowsPathAccessEnvironments(read: () => WslEnvironmentSource): void {
  readKnownEnvironments = read
}

/** The desktop's own OS; a web client has no Windows shell to hand paths to. */
function getDesktopPlatform(): NodeJS.Platform | null {
  if (isWebClientLocation() || typeof navigator === 'undefined') {
    return null
  }
  return navigator.userAgent.includes('Windows') ? 'win32' : null
}

/** {@link windowsPathAccess} for the owner host, from the WSL hosts the renderer knows. */
export function getWindowsPathAccess(
  ownerHostId: string | null | undefined,
  environments?: WslEnvironmentSource
): WindowsPathAccess | null {
  return windowsPathAccess(ownerHostId, {
    platform: getDesktopPlatform(),
    wslDistroForEnvironment: (environmentId) => {
      const deployment = (environments ?? readKnownEnvironments()).find(
        (entry) => entry.id === environmentId
      )?.orcadDeployment
      return deployment?.kind === 'wsl' ? deployment.distro : null
    }
  })
}

export type WslHostWindowsPathAccess = { environmentId: string; access: WindowsPathAccess }

/** Each WSL host whose paths Windows reaches; none off Windows or while the experiment is off. */
export function listWslHostWindowsPathAccess(
  environments: WslEnvironmentSource,
  wslHostsEnabled: boolean
): WslHostWindowsPathAccess[] {
  if (!wslHostsEnabled) {
    return []
  }
  return environments.flatMap((environment) => {
    const access = getWindowsPathAccess(toRuntimeExecutionHostId(environment.id), environments)
    return access ? [{ environmentId: environment.id, access }] : []
  })
}
