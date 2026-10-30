import type { PreloadApi } from '../../../../preload/api-types'
import { noopUnsubscribe } from './web-storage'

export function createWebMobileApi(): Partial<PreloadApi> {
  return {
    mobile: {
      listNetworkInterfaces: () => Promise.resolve({ interfaces: [] }),
      getPairingQR: () => Promise.resolve({ available: false }),
      getWindowsFirewallStatus: () => Promise.resolve({ supported: false }),
      repairWindowsFirewall: () => Promise.resolve({ ok: false, reason: 'unsupported' }),
      openWindowsNetworkSettings: () => Promise.resolve(false),
      getRuntimePairingUrl: () => Promise.resolve({ available: false }),
      listDevices: () => Promise.resolve({ devices: [] }),
      revokeDevice: () => Promise.resolve({ revoked: false }),
      listRuntimeAccessGrants: () => Promise.resolve({ grants: [] }),
      revokeRuntimeAccess: () => Promise.resolve({ revoked: false }),
      getRelayStatus: () => Promise.resolve({ status: 'offline' as const }),
      onRelayStatusChanged: () => noopUnsubscribe,
      consumePendingUnpairedDeviceAuthFailure: () => Promise.resolve(false),
      onUnpairedDeviceAuthFailure: () => noopUnsubscribe
    }
  }
}
