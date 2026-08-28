import type { SshRemotePtyLease } from './ssh-types'

/** A `pty.shutdown` this client issued to an SSH host and could not confirm.
 *
 *  Why it must exist: a relay PTY is a child of the detached relay daemon, not of the ssh channel,
 *  so a shutdown that dies on the transport leaves a live shell — and often a live agent — running
 *  on the user's remote machine with nothing left to retry it. Marking the attempt `unverifiable`
 *  is correct but is not a fix; the kill is an intent that has to outlive the transport failure and
 *  be replayed against the authoritative host when contact returns.
 *
 *  Carried on the existing `SshRemotePtyLease` rather than in a second journal: the lease is
 *  already the durable, restart-surviving, per-`(targetId, relayPtyId)` record of a remote PTY. */
export type SshPendingPtyKill = {
  requestedAt: number
  /** The host-minted PTY incarnation this kill was aimed at, and the whole fence.
   *
   *  A relay renumbers from `pty-1` on every start, so `(targetId, relayPtyId)` alone can name a
   *  DIFFERENT shell after a redeploy — the collision behind #16970. `pty.shutdown` carries no
   *  identity parameter and kills whatever holds the id, so the client has to prove identity before
   *  it replays. The relay mints this per PTY process and publishes it on `pty.listProcesses`,
   *  which makes it the one value that tells the two apart. */
  incarnationId: string
  /** Replays attempted since. Diagnostic; the TTL, not this, is the bound. */
  attempts: number
}

/** Colocated with the type so the two cannot drift. The lease loader is a strict whitelist that
 *  drops anything it does not name, so a record omitted here would be silently stripped on every
 *  launch — the exact failure `closed-terminal-tab-tombstones.ts` records having shipped once. */
export function normalizeSshPendingPtyKill(value: unknown): SshPendingPtyKill | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Partial<SshPendingPtyKill>
  if (typeof raw.requestedAt !== 'number' || !Number.isFinite(raw.requestedAt)) {
    return null
  }
  // No incarnation, no fence, and an unfenced kill order is worse than none.
  if (
    typeof raw.incarnationId !== 'string' ||
    !raw.incarnationId ||
    raw.incarnationId.length > 128
  ) {
    return null
  }
  return {
    requestedAt: raw.requestedAt,
    incarnationId: raw.incarnationId,
    attempts: typeof raw.attempts === 'number' && raw.attempts >= 0 ? raw.attempts : 0
  }
}

/** Backstop only — host acknowledgement is the normal exit. This covers a target the user never
 *  reconnects to, whose intent would otherwise be carried forever. Deliberately longer than the 7d
 *  ceiling on a relay grace window, so the intent outlives the longest window in which the host
 *  could still be holding the PTY it names. */
export const SSH_PENDING_PTY_KILL_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Per target, newest kept. A permanently unreachable host must not grow the store without bound. */
export const MAX_SSH_PENDING_PTY_KILLS_PER_TARGET = 200

/** The single definition of "too old to act on". Both the durable prune and the decision function
 *  read it, so a stale order cannot be replayed by one and kept by the other. */
export function isSshPendingPtyKillExpired(intent: SshPendingPtyKill, now: number): boolean {
  return now - intent.requestedAt > SSH_PENDING_PTY_KILL_TTL_MS
}

/** What the authoritative host just said about this relay PTY id, from one `pty.listProcesses`. */
export type SshPendingPtyKillObservation = {
  /** False only when the host answered and did not list the id: positive evidence of absence.
   *  A failed or timed-out listing is never expressed here — the caller defers instead. */
  hostListsPty: boolean
  /** The incarnation the host published for that id. `undefined` means the host published none,
   *  which reads as unknown — never as "no incarnation" and never as a match. */
  hostIncarnationId: string | undefined
}

export type SshPendingPtyKillRetirement =
  | 'host-reports-absent'
  | 'relay-id-recycled'
  | 'stop-confirmed'

export type SshPendingPtyKillDecision =
  | { action: 'replay' }
  | { action: 'retire'; reason: Exclude<SshPendingPtyKillRetirement, 'stop-confirmed'> }
  | { action: 'defer'; reason: string }

/** Decides what to do with one recorded kill, given what the host just said about its id.
 *
 *  The TTL is deliberately NOT a branch here. `isSshPendingPtyKillExpired` owns it, applied as a
 *  durable prune before any of this runs, so expired orders are actually deleted from the store
 *  rather than merely skipped — and so there is exactly one place that decides what "too old"
 *  means. A branch here would be unreachable behind that prune and would only look tested.
 *
 *  `defer` is the `unverifiable` branch and asserts nothing: the record stays and the next
 *  handshake asks again. No branch concludes that a PTY exited — only `host-reports-absent` is an
 *  observation of absence, and it comes from the host that owns the process. */
export function decideSshPendingPtyKill(
  intent: SshPendingPtyKill,
  observation: SshPendingPtyKillObservation,
  now: number
): SshPendingPtyKillDecision {
  if (isSshPendingPtyKillExpired(intent, now)) {
    // Unreachable behind the prune, but a stale order must never be aimed at whatever holds the
    // id today if a future caller reaches this without pruning first.
    return { action: 'defer', reason: 'order is past its TTL and awaiting prune' }
  }
  if (!observation.hostListsPty) {
    return { action: 'retire', reason: 'host-reports-absent' }
  }
  if (observation.hostIncarnationId === undefined) {
    // Why not replay: an unfenced kill against a renumbered relay id destroys a shell nobody asked
    // to close, which is strictly worse than the leak. Hosts predating the published incarnation
    // therefore degrade to no replay rather than to a guess.
    return { action: 'defer', reason: 'host published no PTY incarnation for this id' }
  }
  if (observation.hostIncarnationId !== intent.incarnationId) {
    return { action: 'retire', reason: 'relay-id-recycled' }
  }
  return { action: 'replay' }
}

export type SshPendingPtyKillEntry = { ptyId: string; intent: SshPendingPtyKill }

/** Newest-first, TTL-filtered and capped — the same shape as `pruneClosedTerminalTabTombstones`. */
export function prunePendingSshPtyKills(
  entries: readonly SshPendingPtyKillEntry[],
  now: number
): SshPendingPtyKillEntry[] {
  return entries
    .filter((entry) => !isSshPendingPtyKillExpired(entry.intent, now))
    .sort((a, b) => b.intent.requestedAt - a.intent.requestedAt)
    .slice(0, MAX_SSH_PENDING_PTY_KILLS_PER_TARGET)
}

/** Reads across every lease state on purpose: a kill issued while the provider was already gone
 *  tombstones its lease `terminated` and still leaves the remote process running. */
export function pendingSshPtyKillEntries(
  leases: readonly SshRemotePtyLease[]
): SshPendingPtyKillEntry[] {
  const entries: SshPendingPtyKillEntry[] = []
  for (const lease of leases) {
    if (lease.pendingKill) {
      entries.push({ ptyId: lease.ptyId, intent: lease.pendingKill })
    }
  }
  return entries
}
