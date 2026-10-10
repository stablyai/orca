export type MobilePairingConnectionMode = 'automatic' | 'local-only'

/**
 * Resolve the pairing path to preselect.
 *
 * A signed-out desktop starts on LAN: Relay's one-click sign-in links this
 * desktop to an Orca account, so it must be an explicit choice. The saved value
 * cannot tell us that, because the settings default persists `automatic`.
 * A click on Relay still selects it; signing in restores a saved Anywhere.
 */
export function resolveMobilePairingConnectionMode(
  saved: MobilePairingConnectionMode | null | undefined,
  context: { signedIn: boolean }
): MobilePairingConnectionMode {
  return saved === 'local-only' || !context.signedIn ? 'local-only' : 'automatic'
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
 */
export function canMintMobilePairingOffer(args: {
  connectionMode: MobilePairingConnectionMode
  signedIn: boolean
}): boolean {
  return !(args.connectionMode === 'automatic' && !args.signedIn)
}
