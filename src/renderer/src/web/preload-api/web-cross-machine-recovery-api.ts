import type { CrossMachineRecoveryApi } from '../../../../shared/cross-machine-recovery-provider-ipc'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { translate } from '@/i18n/i18n'
import { readJson, writeJson } from './web-storage'

const CLIENT_INSTANCE_ID_STORAGE_KEY = 'orca.web.crossMachineRecovery.clientInstanceId.v1'

function unsupported() {
  return {
    ok: false,
    error: {
      code: 'unsupported',
      message: translate(
        'components.cross-machine-recovery.web.unsupported',
        'Cross-machine recovery runs in the desktop app only.'
      )
    }
  } as const
}

function readOrMintClientInstanceId(): string {
  const stored = readJson<string | null>(CLIENT_INSTANCE_ID_STORAGE_KEY, null)
  if (stored) {
    return stored
  }
  const minted = createBrowserUuid()
  writeJson(CLIENT_INSTANCE_ID_STORAGE_KEY, minted)
  return minted
}

// Why: the provider CLI runs next to local Orca; a browser client has no local machine to recover to.
export function createWebCrossMachineRecoveryApi(): CrossMachineRecoveryApi {
  return {
    isSupported: false,
    getClientInstanceId: async () => readOrMintClientInstanceId(),
    status: async () => unsupported(),
    list: async () => unsupported(),
    inspect: async () => unsupported(),
    pickup: async () => unsupported(),
    cancel: async () => {},
    onPickupProgress: () => () => {}
  }
}
