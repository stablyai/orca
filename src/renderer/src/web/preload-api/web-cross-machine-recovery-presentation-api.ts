import type { PreloadApi } from '../../../../preload/api-types'
import { createBrowserUuid } from '../../lib/browser-uuid'

const CLIENT_INSTANCE_STORAGE_KEY = 'orca.web.crossMachineRecovery.clientInstanceId.v1'

function readOrMintWebClientInstanceId(): string {
  const existing = window.localStorage.getItem(CLIENT_INSTANCE_STORAGE_KEY)
  if (existing) {
    return existing
  }
  const minted = createBrowserUuid()
  window.localStorage.setItem(CLIENT_INSTANCE_STORAGE_KEY, minted)
  return minted
}

export function createWebCrossMachineRecoveryPresentationApi(): PreloadApi['crossMachineRecoveryPresentation'] {
  return {
    publishLocal: null,
    getClientInstanceId: () => Promise.resolve(readOrMintWebClientInstanceId()),
    getClientName: () => Promise.resolve(`Orca Web (${window.location.host})`)
  }
}
