import type { CrossMachineRecoveryApi } from '../../../../preload/api/cross-machine-recovery-api'
import { translate } from '@/i18n/i18n'

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

// Why: the provider CLI runs next to local Orca; a browser client has no local machine to recover to.
export function createWebCrossMachineRecoveryApi(): CrossMachineRecoveryApi {
  return {
    isSupported: false,
    status: async () => unsupported(),
    list: async () => unsupported(),
    inspect: async () => unsupported(),
    pickup: async () => unsupported(),
    cancel: async () => {},
    onPickupProgress: () => () => {},
    // Why: recovery imports target this computer's desktop runtime; the web client never hosts one.
    onApply: () => () => {},
    reply: () => {},
    resumeLocal: () => Promise.reject(new Error('recovery_unsupported')),
    releaseLocal: () => Promise.reject(new Error('recovery_unsupported'))
  }
}
