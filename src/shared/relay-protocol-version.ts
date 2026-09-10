/**
 * Semantic wire version for the relay handshake.
 *
 * `RELAY_VERSION` ('0.1.0') has never moved, so the deploy path is namespaced by a content hash
 * of the bundle instead (`config/scripts/build-relay.mjs`). That hash changes on nearly every
 * release, which makes every install directory — and the socket inside it — unreachable to the
 * next build, stranding the PTYs and agents the incumbent still owns (#13852).
 *
 * This integer is the escape: it names what the *wire* can do, independent of what the bytes
 * hash to, exactly as `PROTOCOL_VERSION` does for the local terminal daemon
 * (`src/main/daemon/daemon-protocol-version.ts`). Bump it only when a client and a relay of
 * adjacent versions genuinely cannot drive each other; a rebuild is not a reason.
 */
export const RELAY_PROTOCOL_VERSION = 1

/**
 * Oldest peer protocol this build can still speak. Raising it strands every relay below the new
 * floor for good, so it moves only when serving a version is actually impossible.
 */
export const MIN_RELAY_PROTOCOL_VERSION = 1

/** Rejects a peer's absurd or non-integer claim before it reaches a comparison. */
const MAX_PLAUSIBLE_RELAY_PROTOCOL_VERSION = 1_000_000

/**
 * Contract versions a peer cannot derive from `protocolVersion` alone, because they turn over
 * independently of the handshake.
 */
export type RelayHandshakeCapabilities = {
  /** `pty.openClient` grant contract this relay mints (`PTY_CONSUMER_SESSION_PROTOCOL_VERSION`). */
  readonly ptyConsumerSession?: number
}

/**
 * The protocol range a peer says it can speak. Both fields are optional on the wire: a relay or
 * bridge that predates this negotiation sends neither, which is the signal to fall back to
 * comparing build hashes.
 */
export type RelayProtocolOffer = {
  readonly protocolVersion?: number
  readonly minProtocolVersion?: number
}

function readVersion(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_PLAUSIBLE_RELAY_PROTOCOL_VERSION
    ? value
    : null
}

/** This build's own offer, sent on every handshake and reply. */
export function relayProtocolOffer(): Required<RelayProtocolOffer> {
  return {
    protocolVersion: RELAY_PROTOCOL_VERSION,
    minProtocolVersion: MIN_RELAY_PROTOCOL_VERSION
  }
}

/**
 * Whether a peer offering `offer` can be served by a relay speaking `ownVersion`.
 *
 * The peer states a range rather than a single number so an *older* relay can admit a *newer*
 * client on the first frame — there is no earlier round trip in which the client could learn
 * what to downgrade to, and the stranded relay is by construction the older side.
 *
 * An offer with no `protocolVersion` is not a negotiation at all and never admits: that is a
 * pre-negotiation peer, and the build-hash comparison stays its only gate.
 */
export function relayProtocolOfferAdmits(
  offer: RelayProtocolOffer | undefined,
  ownVersion: number = RELAY_PROTOCOL_VERSION
): boolean {
  const max = readVersion(offer?.protocolVersion)
  if (max === null) {
    return false
  }
  // Why default to `max`: a peer that names one version speaks exactly that one.
  const min = offer?.minProtocolVersion === undefined ? max : readVersion(offer.minProtocolVersion)
  if (min === null) {
    return false
  }
  // An inverted range admits nothing rather than being reordered into something the peer never
  // offered: `min > max` simply fails this band.
  return ownVersion >= min && ownVersion <= max
}
