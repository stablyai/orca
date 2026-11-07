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

/** Signed-out desktops default to LAN: Relay sign-in links an account and needs an explicit choice; persisted automatic does not prove consent.
 * Explicit Relay remains selectable; sign-in restores saved Anywhere. */
export function resolveMobilePairingConnectionMode(
  saved: MobilePairingConnectionMode | null | undefined,
  context: { signedIn: boolean }
): MobilePairingConnectionMode {
  const mode = parseMobilePairingConnectionMode(saved ?? 'automatic')
  // Why: Iroh needs no account, so the signed-out LAN fallback does not apply.
  if (mode === 'iroh') {
    return 'iroh'
  }
  return mode === 'local-only' || !context.signedIn ? 'local-only' : 'automatic'
}

/** Modes that must never receive Relay credentials or splices. */
export function isMobilePairingRelayDisabled(mode: MobilePairingConnectionMode): boolean {
  return mode === 'local-only' || mode === 'iroh'
}

/** Anywhere QR mode requires a signed-in desktop Relay session. */
export function effectiveMobilePairingConnectionMode(args: {
  preferred: MobilePairingConnectionMode
  signedIn: boolean
}): MobilePairingConnectionMode {
  if (args.preferred === 'automatic' && !args.signedIn) {
    return 'local-only'
  }
  return args.preferred
}

/** Gate both mint surfaces: unsigned Anywhere cannot silently produce a LAN-only QR under the Relay label. Iroh and LAN need no sign-in. */
export function canMintMobilePairingOffer(args: {
  connectionMode: MobilePairingConnectionMode
  signedIn: boolean
}): boolean {
  return !(args.connectionMode === 'automatic' && !args.signedIn)
}
