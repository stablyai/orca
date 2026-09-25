import type { PreloadApi } from '../../../../preload/api-types'
import { webRuntimeState } from './web-runtime-session'
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
      getTunnelStatus: () =>
        Promise.resolve({
          installed: false,
          binaryPath: null,
          installHint: '',
          compatible: null,
          version: null,
          incompatibleReason: null,
          server: { state: 'stopped' as const, port: null }
        }),
      listDevices: () => Promise.resolve({ devices: [] }),
      revokeDevice: () => Promise.resolve({ revoked: false }),
      listRuntimeAccessGrants: () => Promise.resolve({ grants: [] }),
      revokeRuntimeAccess: () => Promise.resolve({ revoked: false }),
      isWebSocketReady: () =>
        Promise.resolve({ ready: Boolean(webRuntimeState.activeEnvironment), endpoint: null }),
      getRelayStatus: () => Promise.resolve({ status: 'offline' as const }),
      onRelayStatusChanged: () => noopUnsubscribe,
      consumePendingUnpairedDeviceAuthFailure: () => Promise.resolve(false),
      onUnpairedDeviceAuthFailure: () => noopUnsubscribe
    }
  }
}
