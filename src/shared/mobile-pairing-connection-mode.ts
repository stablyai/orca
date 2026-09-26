export type MobilePairingConnectionMode = 'automatic' | 'local-only'

/**
 * Resolve the pairing path to show / remember.
 *
 * - Explicit saved preference wins (user already chose).
 * - Otherwise default to Anywhere (`automatic`). Relay still requires authorization
 *   at QR time; the UI can keep Anywhere selected while signed out.
 */
export function resolveMobilePairingConnectionMode(
  saved: MobilePairingConnectionMode | null | undefined
): MobilePairingConnectionMode {
  return saved === 'local-only' ? 'local-only' : 'automatic'
}

/**
 * Mode encoded into a pairing QR. Anywhere cannot be committed without a
 * Cloud session or self-hosted Relay key.
 */
export function effectiveMobilePairingConnectionMode(args: {
  preferred: MobilePairingConnectionMode
  relayAuthorized: boolean
}): MobilePairingConnectionMode {
  if (args.preferred === 'automatic' && !args.relayAuthorized) {
    return 'local-only'
  }
  return args.preferred
}

/**
 * Whether a scannable pairing offer may be minted for the selected path. Anywhere
 * (Relay) needs desktop authorization; minting a local-only QR under the Relay
 * label would misrepresent what the code encodes, so both surfaces gate
 * generation on this rather than silently degrading to local-only.
 */
export function canMintMobilePairingOffer(args: {
  connectionMode: MobilePairingConnectionMode | 'self-hosted'
  relayAuthorized: boolean
}): boolean {
  return args.connectionMode === 'local-only' || args.relayAuthorized
}
