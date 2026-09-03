import type { ForegroundProcessEvidence } from './foreground-process-evidence'

/** Which relay PTYs a client may prove it orphaned, and therefore may stop (#9819).
 *
 *  A relay PTY is a child of the detached relay daemon. Stopping one destroys a running process —
 *  often a running agent — on the user's remote machine, and the relay's 50-slot cap is a far
 *  cheaper failure than that. So every rule below is written to answer "can this client PROVE
 *  nobody owns this?" and to answer "no" whenever it cannot.
 *
 *  The rule #9819 proposed — "pane-bound and the app no longer owns or leases it" — is not that
 *  proof. Absence from a client-side set is `unverifiable` by construction
 *  (`docs/reference/ssh-execution-boundary.md`): a second machine running the same Orca build
 *  connects to the SAME relay and displaces the session owner, and its PTYs are missing from THIS
 *  client's store for exactly the same reason a genuine orphan is. Sweeping on local absence alone
 *  would let one laptop reap another laptop's live agents.
 *
 *  What replaces it: the host itself records which authenticated consumer identity asked it to
 *  create each PTY, and publishes that back. A PTY is sweepable only when the OWNING HOST names
 *  this client as its creator and this client's own durable state has no route to it. Both halves
 *  are required; either alone is a guess.
 */

/** One `pty.listProcesses` entry, as far as this decision is concerned. Every field a host may
 *  omit is optional here, because a host predating it publishes nothing rather than a default. */
export type RelayPtyOwnershipEvidence = {
  /** Relay-scoped PTY id. */
  ptyId: string
  incarnationId?: string
  ownerClientInstanceId?: string
  hostAgeMs?: number
  paneBound?: boolean
  /** Non-empty when the host still advertises an adoptable agent session on this PTY. */
  agentSessionOwners?: readonly unknown[]
  /** What the OWNING host saw in the pane on the same listing. This answers a different question
   *  from `agentSessionOwners`: that one asks whether Orca REGISTERED an agent session here, this
   *  one asks whether anything at all is running. A `claude` the user typed by hand registers
   *  nothing, so only this can see it. */
  foregroundProcessEvidence?: ForegroundProcessEvidence
}

export type RelayPtySweepContext = {
  /** This client's persisted consumer identity for the target. */
  clientInstanceId: string
  /** Whether the relay granted THIS connection the `session-owner` role. A subscriber, or a client
   *  that fell back to the unnegotiated legacy path, never sweeps. */
  isSessionOwner: boolean
  /** Every relay PTY id this client still has any route to: a live provider PTY, a lease it has
   *  not tombstoned, an id it just reattached, or a stop it has recorded and not yet delivered. */
  routedPtyIds: ReadonlySet<string>
  /** Relay PTY ids this client holds an `expired` lease for.
   *
   *  Separate from {@link routedPtyIds} because it is a different fact with the same verdict: an
   *  expired lease records that THIS CLIENT lost its handle — a pane re-leased under a new relay
   *  id, a pane surface that is no longer in the layout, a retired reattach. The layout case is the
   *  one that matters most, because it is reached only AFTER `pty.attach` succeeded: the process is
   *  not merely unproven, it is known to be alive. Every one of those writers deliberately declines
   *  to stop it, and client-side absence is `unverifiable` by construction
   *  (`docs/reference/ssh-execution-boundary.md`). So an expired lease is the record of a process
   *  left running on purpose, never a licence to kill it. */
  expiredLeasePtyIds: ReadonlySet<string>
  /** Host-measured age a PTY must exceed. Guards a spawn that is in flight from another window of
   *  this same client and has not written its lease yet. */
  minimumHostAgeMs: number
  /** How long ago, on THIS client's clock, the listing that carried the evidence arrived. Added to
   *  each entry's host-stamped `capturedAgeMs` so {@link maximumEvidenceAgeMs} bounds staleness at
   *  the moment of the decision rather than at the moment of serialization. The transit itself is
   *  unmeasured — the two clocks are not synchronized — but it is bounded by the listing's own RPC
   *  deadline, and both halves that ARE measurable are counted. */
  evidenceAgeSinceListingMs: number
  /** Oldest foreground observation that may authorize a stop. Stale evidence degrades to "do not
   *  sweep", never to "sweep". */
  maximumEvidenceAgeMs: number
}

export type RelayPtySweepTarget = { ptyId: string; incarnationId: string }

export type RelayPtySweepSkip = { ptyId: string; reason: string }

export type RelayPtySweepPlan = {
  sweep: RelayPtySweepTarget[]
  skipped: RelayPtySweepSkip[]
}

/** Deliberately longer than any single connect round trip. A PTY younger than this is never worth
 *  the risk: the leak it represents costs one slot for 30 more seconds, and reaping a shell that a
 *  concurrent spawn is still recording costs the user a terminal. */
export const RELAY_PTY_SWEEP_MIN_AGE_MS = 30_000

/** Bounds one pass. A relay is capped at 50 PTYs, so a pass that wants to stop more than this is
 *  not reclaiming a leak — it is a disagreement about ownership, and stopping is the wrong move. */
export const RELAY_PTY_SWEEP_MAX_PER_PASS = 8

/** The oldest foreground observation this sweep will treat as authorization to SIGKILL.
 *
 *  Sized to the pass budget rather than to the 30s spawn floor: those answer different questions.
 *  The floor guards a concurrent spawn this client has not recorded yet; this one guards the pane
 *  the user started working in AFTER the host looked. An observation older than the whole pass it
 *  is meant to authorize cannot have been taken for this pass, so it is not evidence about now.
 *
 *  It does not remove the race — nothing can, the host cannot re-check between the answer and the
 *  signal — it bounds it. The display consumer of the same measurement deliberately keeps NO age
 *  budget: a stale pane title costs a redraw and self-corrects on the next poll, so one truthful
 *  number carries two explicit budgets rather than one implicit one. */
export const RELAY_PTY_SWEEP_MAX_EVIDENCE_AGE_MS = 5_000

/** The host's own answer to "is anything running in this pane?". Only a positive "no" clears the
 *  sweep; every other shape — an older host, an unreadable process table, an observation too old to
 *  describe now, a named foreground process, any other process group on the pane's terminal — is a
 *  reason to leave the process alone. */
function foregroundSkipReason(
  evidence: ForegroundProcessEvidence | undefined,
  context: RelayPtySweepContext
): string | null {
  if (evidence === undefined) {
    // A host that never published it, or a Windows host where it is not collected. Absence of the
    // observation is not the observation of absence.
    return 'host published no foreground-process observation'
  }
  // Before anything is read out of it: an observation is only a claim about the instant it was
  // taken. Age is checked on both verdicts because a stale `unverifiable` is no better.
  if (evidence.capturedAgeMs + context.evidenceAgeSinceListingMs > context.maximumEvidenceAgeMs) {
    return 'host foreground observation is too old to authorize a stop'
  }
  if (evidence.verdict !== 'live') {
    return 'host could not observe the pane foreground process'
  }
  if (evidence.processName !== null) {
    // The host named something running in the pane. It registered no agent session, which is
    // exactly the hand-launched `claude`/`codex` case agentSessionOwners cannot see.
    return 'host observes a named foreground process'
  }
  if (evidence.shellOwnsEveryTtyProcessGroup !== true) {
    // Something other than the shell's own process group is attached to the pane's terminal — a
    // foreground command, a job backgrounded with `&`, a Ctrl-Z'd editor — or this host predates
    // the field. The stop would SIGKILL that group, so none of those is a pane to reclaim.
    return 'host does not attest an idle shell'
  }
  return null
}

function skipReason(
  entry: RelayPtyOwnershipEvidence,
  context: RelayPtySweepContext
): string | null {
  if (typeof entry.incarnationId !== 'string' || entry.incarnationId.length === 0) {
    // Without the host's own incarnation there is no fence, and an unfenced stop aimed at a relay
    // id can hit whatever holds that id by the time it lands.
    return 'host published no PTY incarnation'
  }
  if (typeof entry.ownerClientInstanceId !== 'string' || entry.ownerClientInstanceId.length === 0) {
    return 'host attested no owning client'
  }
  if (entry.ownerClientInstanceId !== context.clientInstanceId) {
    return 'host attests another client created it'
  }
  if (entry.paneBound !== true) {
    // Covers both a bare host shell (a remote CLI terminal nobody's pane owns) and a host that
    // never published the field. Neither is a pane this client lost.
    return 'not a pane-bound PTY'
  }
  if (entry.agentSessionOwners !== undefined && entry.agentSessionOwners.length > 0) {
    // The host still advertises this session as adoptable, so a later spawn can reclaim the running
    // agent. Reaping it converts a recoverable session into a destroyed one.
    return 'host still advertises an adoptable agent session'
  }
  const foregroundSkip = foregroundSkipReason(entry.foregroundProcessEvidence, context)
  if (foregroundSkip !== null) {
    return foregroundSkip
  }
  if (typeof entry.hostAgeMs !== 'number' || !Number.isFinite(entry.hostAgeMs)) {
    return 'host published no age'
  }
  if (entry.hostAgeMs < context.minimumHostAgeMs) {
    return 'younger than the sweep floor'
  }
  if (context.routedPtyIds.has(entry.ptyId)) {
    return 'this client still has a route to it'
  }
  if (context.expiredLeasePtyIds.has(entry.ptyId)) {
    return 'this client expired its lease without ordering a stop'
  }
  return null
}

/** Plans one sweep pass. Pure: every input is evidence the caller already gathered, so the rule can
 *  be tested without a relay, and the irreversible call sits with the caller. */
export function planRelayPtySweep(
  entries: readonly RelayPtyOwnershipEvidence[],
  context: RelayPtySweepContext
): RelayPtySweepPlan {
  if (!context.isSessionOwner || !context.clientInstanceId) {
    return {
      sweep: [],
      skipped: entries.map((entry) => ({
        ptyId: entry.ptyId,
        reason: 'this client does not hold the relay session-owner grant'
      }))
    }
  }
  const sweep: RelayPtySweepTarget[] = []
  const skipped: RelayPtySweepSkip[] = []
  for (const entry of entries) {
    const reason = skipReason(entry, context)
    if (reason !== null) {
      skipped.push({ ptyId: entry.ptyId, reason })
    } else {
      sweep.push({ ptyId: entry.ptyId, incarnationId: entry.incarnationId as string })
    }
  }
  if (sweep.length > RELAY_PTY_SWEEP_MAX_PER_PASS) {
    // Why refuse rather than truncate: at this size the disagreement is about ownership, not about
    // a handful of leaked slots, and a truncated pass would work through the same list one connect
    // at a time and destroy it all anyway.
    return {
      sweep: [],
      skipped: [
        ...skipped,
        ...sweep.map((target) => ({
          ptyId: target.ptyId,
          reason: `refusing a ${sweep.length}-PTY sweep; over the ${RELAY_PTY_SWEEP_MAX_PER_PASS} per-pass ceiling`
        }))
      ]
    }
  }
  return { sweep, skipped }
}
