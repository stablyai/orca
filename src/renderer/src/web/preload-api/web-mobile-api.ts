import type { PreloadApi } from '../../../../preload/api-types'
import { idlePublicTunnelState } from '../../../../shared/public-tunnel-types'
import { noopUnsubscribe } from './web-storage'

// A browser page cannot own the desktop's cloudflared child. The desktop tunnel is
// started from Settings in the Electron window, so the web surface reports why.
function unsupportedPublicTunnel(): ReturnType<typeof idlePublicTunnelState> {
  return {
    ...idlePublicTunnelState(),
    status: 'error',
    error: {
      code: 'unsupported',
      message: 'Public tunnels can only be started from the Orca desktop app.'
    }
  }
}

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
      startPublicTunnel: () => Promise.resolve(unsupportedPublicTunnel()),
      stopPublicTunnel: () => Promise.resolve(unsupportedPublicTunnel()),
      getPublicTunnelStatus: () => Promise.resolve(unsupportedPublicTunnel()),
      onPublicTunnelStatusChanged: () => noopUnsubscribe,
      consumePendingUnpairedDeviceAuthFailure: () => Promise.resolve(false),
      onUnpairedDeviceAuthFailure: () => noopUnsubscribe
    }
  }
}
