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
 * ## This negotiation is not reachable yet. Do not read it as fixing #13852.
 *
 * Measured, not inferred: the deploy path namespaces the relay directory by the CLIENT'S OWN build
 * hash — `remoteInstallDirName` is `relay-<fullVersion>` — and the daemon socket lives inside that
 * directory (`ssh-relay-deploy.ts`, `--connect --sock-path ~/.orca-remote/relay-<ownVersion>/…`;
 * the short-socket fallback derives its segment from the same version dir). Every
 * `runConnectHandshake` caller takes its path from that one deploy result. So a bridge can only
 * ever meet a daemon of its own build, `msg.version === launchVersion` short-circuits first, and
 * `relayProtocolOfferAdmits` never decides anything on any live path. The stranded incumbent this
 * exists for sits in `relay-<otherVersion>/`, which nothing dials.
 *
 * What ships today is therefore three log lines: `describeRelayProtocolVersion` in
 * `relay-handshake.ts`. `MIN_RELAY_PROTOCOL_VERSION` and the `minProtocolVersion` wire field have
 * no live reader at all.
 *
 * Keep it — the mechanism is correct and hostile-input-safe, and it is the part that has to exist
 * first. Making it live needs THREE more changes, all of which must land together. Landing only
 * the first two ships a negotiation that still refuses, later and less legibly:
 *   1. route the bridge to the incumbent's socket rather than to its own version directory;
 *   2. stop `validateGrant` (`ssh-pty-consumer-session.ts`) refusing on `serverBuildId`. Its
 *      premise, "client and relay ship in one build", is still TRUE today and becomes false the
 *      moment (1) lands — it is a second gate that would refuse what the handshake just admitted.
 *   3. give that same refusal a way to survive a protocol-version difference. It is ONE `if` with
 *      two disjuncts, and deleting the `serverBuildId` clause leaves the other one standing:
 *      `grant.protocolVersion !== PTY_CONSUMER_SESSION_PROTOCOL_VERSION` — a DIFFERENT constant
 *      from this file's `RELAY_PROTOCOL_VERSION`, compared for exact equality, with no range, no
 *      floor and no fallback. Two peers that just negotiated a compatible relay protocol are still
 *      refused if their PTY-session constants differ by one. And there is nothing to negotiate it
 *      with: `capabilities` on `orca-relay-handshake-ok` is written at exactly one site
 *      (`relay-handshake.ts`) and read by nothing outside tests, so (3) means giving that field a
 *      reader before it can carry the peer's PTY-session protocol.
 *
 * Budget a debugging session for the error text too: the refusal interpolates only the build ids,
 * so a pure protocol-version mismatch reports as "expected build X, got X" with two IDENTICAL ids,
 * which points at the gate that is not the problem.
 *
 * Until all three land, a change here cannot be validated by any end-to-end test, only by the
 * handshake's own unit suite.
 */

/**
 * Oldest peer protocol this build can still speak. Raising it strands every relay below the new
 * floor for good, so it moves only when serving a version is actually impossible.
 *
 * No live reader — see the note above. It is serialized onto every handshake and reply so that the
 * field exists on the wire before any peer needs it (Rule 1, docs/reference/remote-wire-
 * compatibility.md); an older peer ignoring it today is the point.
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

/**
 * Renders a peer's claimed version for a log line without interpolating it.
 *
 * `JSON.parse` can hand back `{ "toString": 1 }`, and a template literal on that throws
 * `Cannot convert object to primitive value` — inside the frame-decoder callback, which would
 * take the daemon and every PTY it holds down with it.
 */
export function describeRelayProtocolVersion(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'none'
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
