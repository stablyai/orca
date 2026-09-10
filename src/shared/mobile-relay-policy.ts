import type { MobilePairingConnectionMode } from './mobile-pairing-connection-mode'

/**
 * May this desktop serve a paired mobile device over Relay right now?
 *
 * Restrictive-only: the host-level setting withdraws Relay from an `automatic`
 * device but never grants it to one paired `local-only`. A device the registry
 * cannot place (`null`) contributes no opinion. The mint question (what the next
 * QR encodes) stays in `mobile-pairing-connection-mode.ts`.
 */
export function isMobileRelayAllowed(args: {
  hostConnectionMode: MobilePairingConnectionMode
  deviceConnectionMode: MobilePairingConnectionMode | null
}): boolean {
  return args.hostConnectionMode !== 'local-only' && args.deviceConnectionMode !== 'local-only'
}
