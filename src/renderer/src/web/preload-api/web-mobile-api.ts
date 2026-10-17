import type { PreloadApi } from '../../../../preload/api-types'
import type { MobileHostStatus } from '../../../../shared/mobile-pairing-rpc-contract'
import { callRuntimeResult } from './web-runtime-calls'
import { noopUnsubscribe } from './web-storage'

// Why: paired web clients carry no Electron IPC, so the mobile surface answers
// from the host's mobile.* RPC methods over the runtime WebSocket instead of a
// preload bridge. Firewall/repair calls have no RPC equivalent (and only exist
// for Windows desktops), so they keep their local stubs.
export function createWebMobileApi(): Partial<PreloadApi> {
  const hostStatus = () => callRuntimeResult<MobileHostStatus>('mobile.hostStatus')
  return {
    mobile: {
      listNetworkInterfaces: () => callRuntimeResult('mobile.listNetworkInterfaces'),
      getPairingQR: (args) => callRuntimeResult('mobile.getPairingQR', args),
      getWindowsFirewallStatus: () => Promise.resolve({ supported: false }),
      repairWindowsFirewall: () => Promise.resolve({ ok: false, reason: 'unsupported' }),
      openWindowsNetworkSettings: () => Promise.resolve(false),
      getRuntimePairingUrl: (args) => callRuntimeResult('mobile.getRuntimePairingUrl', args),
      listDevices: () => callRuntimeResult('mobile.listDevices'),
      revokeDevice: (args) => callRuntimeResult('mobile.revokeDevice', args),
      listRuntimeAccessGrants: () => Promise.resolve({ grants: [] }),
      revokeRuntimeAccess: () => Promise.resolve({ revoked: false }),
      isWebSocketReady: async () => {
        const status = await hostStatus()
        return {
          ready: status.webSocketEndpoint !== null,
          endpoint: status.webSocketEndpoint
        }
      },
      getRelayStatus: async () => ({
        // Why: relayAvailable is the only relay fact the host publishes over RPC;
        // a host without the desktop relay provider answers false.
        status: (await hostStatus()).relayAvailable ? 'registered' : 'offline'
      }),
      onRelayStatusChanged: () => noopUnsubscribe,
      consumePendingUnpairedDeviceAuthFailure: () => Promise.resolve(false),
      onUnpairedDeviceAuthFailure: () => noopUnsubscribe
    }
  }
}
