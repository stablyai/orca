import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'
import type { MobileRelayMintFailure } from '../../../../shared/mobile-relay-mint-failure'
import type { MobileRelayStatus } from '../../../../shared/mobile-relay-status'

export type MobileRelayDiagnosticsPayload = {
  kind: 'mobile_pairing_relay_failure'
  preferredConnectionMode: MobilePairingConnectionMode
  failure: MobileRelayMintFailure
  relayStatus: MobileRelayStatus
  appVersion: string
  at: string
}

// Why status only, not the full MobileRelayStatusDetail: users share this
// payload, and cellUrl (like the selected address) is a network identifier.
export function buildMobileRelayDiagnosticsPayload(args: {
  connectionMode: MobilePairingConnectionMode
  failure: MobileRelayMintFailure
  relayStatus: MobileRelayStatus
  appVersion: string
}): MobileRelayDiagnosticsPayload {
  return {
    kind: 'mobile_pairing_relay_failure',
    preferredConnectionMode: args.connectionMode,
    failure: args.failure,
    relayStatus: args.relayStatus,
    appVersion: args.appVersion,
    at: new Date().toISOString()
  }
}
