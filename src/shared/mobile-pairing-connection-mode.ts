export type MobilePairingConnectionMode = 'automatic' | 'local-only' | 'iroh'

/**
 * Parse a persisted/IPC connection mode. Unknown values (future modes written
 * by a newer desktop, corrupt registry data) degrade to Anywhere so older
 * builds keep a working Relay-capable default rather than crashing.
 */
export function parseMobilePairingConnectionMode(value: unknown): MobilePairingConnectionMode {
  if (value === 'local-only' || value === 'iroh' || value === 'automatic') {
    return value
  }
  return 'automatic'
}

/**
 * Resolve the pairing path to show / remember.
 *
 * - Explicit saved preference wins (user already chose).
 * - Otherwise default to Anywhere (`automatic`). Relay still requires sign-in
 *   at QR time; the UI can keep Anywhere selected while signed out.
 */
export function resolveMobilePairingConnectionMode(
  saved: MobilePairingConnectionMode | null | undefined
): MobilePairingConnectionMode {
  return parseMobilePairingConnectionMode(saved)
}

/** Modes that must never receive Relay credentials or splices. */
export function isMobilePairingRelayDisabled(mode: MobilePairingConnectionMode): boolean {
  return mode === 'local-only' || mode === 'iroh'
}

/**
 * Mode encoded into a pairing QR. Anywhere cannot be committed without a
 * signed-in desktop session for Relay.
 */
export function effectiveMobilePairingConnectionMode(args: {
  preferred: MobilePairingConnectionMode
  signedIn: boolean
}): MobilePairingConnectionMode {
  if (args.preferred === 'automatic' && !args.signedIn) {
    return 'local-only'
  }
  return args.preferred
}

/**
 * Whether a scannable pairing offer may be minted for the selected path. Anywhere
 * (Relay) needs a signed-in desktop; minting a local-only QR under the Relay
 * label would misrepresent what the code encodes, so both surfaces gate
 * generation on this rather than silently degrading to local-only.
 * Iroh and LAN do not require sign-in (endpoint readiness is a separate UI gate).
 */
export function canMintMobilePairingOffer(args: {
  connectionMode: MobilePairingConnectionMode
  signedIn: boolean
}): boolean {
  return !(args.connectionMode === 'automatic' && !args.signedIn)
}
