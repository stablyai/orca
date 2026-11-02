/** A `pty.shutdown` a relay-era client issued to an SSH host and could not confirm, carried on its
 *  `SshRemotePtyLease`. This build never records or replays one; it keeps the field through
 *  load and save so a downgraded build can still replay it. */
export type SshPendingPtyKill = {
  requestedAt: number
  /** The host-minted PTY incarnation this kill was aimed at, and the fence.
   *
   *  A legacy relay renumbers from `pty-1` on every start, so `(targetId, relayPtyId)` alone can
   *  name a DIFFERENT shell after a redeploy — the collision behind #16970. Current relays enforce
   *  this identity on `pty.shutdown`; the client also proves it from `pty.listProcesses` before
   *  replay so older relays that ignore the additive field keep the safest available fallback.
   *
   *  Absent only for a `pty2:` id, whose per-start mint epoch makes the id itself the fence. */
  incarnationId?: string
  /** Replays attempted since. Diagnostic; the TTL, not this, is the bound. */
  attempts: number
}

/** Whether a relay PTY id names exactly one process: current relays mint `pty2:<epoch>:<n>` with a
 *  fresh epoch per start, so the id never recurs. Legacy `pty-N` ids restart at 1. */
function isEpochScopedRelayPtyId(relayPtyId: string): boolean {
  return relayPtyId.startsWith('pty2:')
}

/** Colocated with the type so the two cannot drift. The lease loader is a strict whitelist that
 *  drops anything it does not name, so a record omitted here would be silently stripped on every
 *  launch — the exact failure `closed-terminal-tab-tombstones.ts` records having shipped once. */
export function normalizeSshPendingPtyKill(
  value: unknown,
  relayPtyId: string
): SshPendingPtyKill | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Partial<SshPendingPtyKill>
  if (typeof raw.requestedAt !== 'number' || !Number.isFinite(raw.requestedAt)) {
    return null
  }
  const attempts = typeof raw.attempts === 'number' && raw.attempts >= 0 ? raw.attempts : 0
  if (raw.incarnationId === undefined && isEpochScopedRelayPtyId(relayPtyId)) {
    return { requestedAt: raw.requestedAt, attempts }
  }
  // No fence, and an unfenced kill order is worse than none.
  if (
    typeof raw.incarnationId !== 'string' ||
    !raw.incarnationId ||
    raw.incarnationId.length > 128
  ) {
    return null
  }
  return { requestedAt: raw.requestedAt, incarnationId: raw.incarnationId, attempts }
}
