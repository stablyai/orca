export type MobilePairingConnectionMode = 'automatic' | 'local-only'

/** Signed-out desktops default to LAN: Relay sign-in links an account and needs an explicit choice; persisted automatic does not prove consent.
 * Explicit Relay remains selectable; sign-in restores saved Anywhere. */
export function resolveMobilePairingConnectionMode(
  saved: MobilePairingConnectionMode | null | undefined,
  context: { signedIn: boolean }
): MobilePairingConnectionMode {
  return saved === 'local-only' || !context.signedIn ? 'local-only' : 'automatic'
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

/** Gate both mint surfaces: unsigned Anywhere cannot silently produce a LAN-only QR under the Relay label. */
export function canMintMobilePairingOffer(args: {
  connectionMode: MobilePairingConnectionMode
  signedIn: boolean
}): boolean {
  return !(args.connectionMode === 'automatic' && !args.signedIn)
}
