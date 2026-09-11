import type { MobilePairingConnectionMode } from '../../../../shared/mobile-pairing-connection-mode'
import type { MobileRelayMintFailure } from '../../../../shared/mobile-relay-mint-failure'
import type { MobileRelayStatus } from '../../../../shared/mobile-relay-status'
import { resolveClientEnvironmentInfo } from '@/lib/client-environment-info'

/** The status lookup's own failure, kept distinct from the host answering 'offline'. */
export const MOBILE_RELAY_DIAGNOSTICS_STATUS_UNREADABLE = 'unreadable'

export type MobileRelayDiagnosticsStatus =
  | MobileRelayStatus
  | typeof MOBILE_RELAY_DIAGNOSTICS_STATUS_UNREADABLE

export type MobileRelayDiagnosticsPayload = {
  kind: 'mobile_pairing_relay_failure'
  preferredConnectionMode: MobilePairingConnectionMode
  failure: MobileRelayMintFailure
  relayStatus: MobileRelayDiagnosticsStatus
  appVersion: string
  at: string
}

// Why status only, not the full MobileRelayStatusDetail: users share this
// payload, and cellUrl (like the selected address) is a network identifier.
export function buildMobileRelayDiagnosticsPayload(args: {
  connectionMode: MobilePairingConnectionMode
  failure: MobileRelayMintFailure
  relayStatus: MobileRelayDiagnosticsStatus
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

/**
 * Why not 'offline' on failure: this payload is what a user pastes into a bug report, and
 * 'offline' is a claim the broker was down. A status call this renderer could not complete
 * observed nothing (docs/reference/ssh-execution-boundary.md), and reporting it as the definite
 * neighbour points triage at the relay instead of at the lookup that actually failed.
 *
 * Why the whole call and not just a `.catch`: both Copy-diagnostics buttons fire this as
 * `void copyRelayDiagnostics()`, and the await now sits ahead of their try/catch, so a bridge
 * missing `mobile` — which throws where a rejected promise was expected — would leave the click
 * with no clipboard write and no toast at all.
 */
async function readRelayStatusForDiagnostics(): Promise<MobileRelayDiagnosticsStatus> {
  try {
    return (await window.api.mobile.getRelayStatus()).status
  } catch {
    return MOBILE_RELAY_DIAGNOSTICS_STATUS_UNREADABLE
  }
}

// Why here rather than at each call site: both "Copy diagnostics" buttons must
// fetch the same two fields the same way, and MobilePane sits at the line ceiling.
export async function collectMobileRelayDiagnosticsPayload(args: {
  connectionMode: MobilePairingConnectionMode
  failure: MobileRelayMintFailure
}): Promise<MobileRelayDiagnosticsPayload> {
  const [relayStatus, environment] = await Promise.all([
    readRelayStatusForDiagnostics(),
    resolveClientEnvironmentInfo()
  ])
  return buildMobileRelayDiagnosticsPayload({
    ...args,
    relayStatus,
    appVersion: environment.appVersion
  })
}
