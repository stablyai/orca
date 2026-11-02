import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { StoredWebRuntimeEnvironment } from '../web-runtime-environment'
import { webRuntimeState } from './web-runtime-session'

export function zcodePlanSiteOwner(environment: StoredWebRuntimeEnvironment | null): string | null {
  return environment
    ? JSON.stringify([environment.id, environment.pairingRevision ?? environment.createdAt])
    : null
}

export function settingsForZcodePlanSiteOwner(
  settings: GlobalSettings,
  environment: StoredWebRuntimeEnvironment | null
): GlobalSettings {
  const owner = zcodePlanSiteOwner(environment)
  return {
    ...settings,
    zcodePlanSite:
      owner && owner === webRuntimeState.zcodePlanSiteRuntimeOwner
        ? (webRuntimeState.zcodePlanSiteRuntimeValue ?? undefined)
        : undefined
  }
}
