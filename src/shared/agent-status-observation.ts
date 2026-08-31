// ─── Observation provenance for agent status (STA-4293, step 1) ─────────────
// An AgentStatusEntry today cannot say who observed it, on whose clock, or in what
// order relative to the pane's other observations. Hook rows carry main's
// watermark-forced monotonic clock while byte-derived rows carry the renderer's
// Date.now(), and both are arbitrated by one strict `<` on updatedAt. This facet
// records the missing facts at every ingress.
//
// NOTHING READS IT YET. It is stamped so consumers can be migrated one at a time.

/** Where the evidence for a status row came from — the ingress, not the transport.
 *  A hook event relayed over SSH is still `hook`; the relay is a carrier. */
export const AGENT_STATUS_OBSERVATION_ORIGINS = [
  /** Provider hook event (loopback HTTP or relayed), run through a provider normalizer. */
  'hook',
  /** OSC 9999 structured payload parsed out of PTY bytes. Canonical payload, no provider normalizer. */
  'osc',
  /** Inferred from a terminal title. The weakest evidence Orca acts on. */
  'title',
  /** Derived from the pane's own process/output evidence (e.g. Command Code output seeds). */
  'process',
  /** Seeded when Orca launched the agent itself, before any provider signal. */
  'launch',
  /** Stamped by orchestration dispatch rather than by the agent. */
  'orchestration'
] as const
export type AgentStatusObservationOrigin = (typeof AGENT_STATUS_OBSERVATION_ORIGINS)[number]

/**
 * What the observation claims, independent of `state`.
 * - `transition` — an event asserting the pane just changed state.
 * - `snapshot` — a repaint/replay of the state already believed true (OSC repaints, relay
 *   replay, title-derived rows re-derived every render). Never proof of a new turn.
 * - `identity-only` — a resume-identity refresh whose status-shaped fields are transport
 *   placeholders (`providerSessionOnly`, agent-status-types.ts). PR #14657 had to
 *   special-case exactly this; the facet exists so the next consumer need not rediscover it.
 */
export type AgentStatusObservationKind = 'transition' | 'snapshot' | 'identity-only'

export type AgentStatusObservation = {
  origin: AgentStatusObservationOrigin
  /** Which component sequenced this observation. Opaque; see the ordering rule below. */
  authorityId: string
  /** Bumped when the pane/PTY behind this key is rebound. Non-decreasing per pane. */
  incarnation: number
  /** Monotonic per pane within one authority. Compare it; never count with it (values are shared
   *  across the authority's panes, so consecutive observations of one pane leave gaps). */
  revision: number
  /** The AUTHORITY's clock when it sequenced this observation — not the reader's. */
  observedAt: number
  /** This observation is a user-initiated new turn. Stamped from the hook listener's
   *  own per-provider `isNewTurnEvent`, never from a fresh list of event-name literals:
   *  the retired-pane gate (server.ts) matched two raw literals and stranded providers
   *  whose boundary event is named anything else — the defect PR #14626 fixed one instance of. */
  boundary?: true
  kind?: AgentStatusObservationKind
}

/** The observation facet, mixed into every row shape that carries one. Optional and read by
 *  nothing yet (STA-4293): rows from old hosts, persisted rehydration, and any ingress not yet
 *  stamped carry none, so consumers must keep working without it. Deliberately NOT mixed into
 *  `AgentStatusPayload` — the ingress stamps it and it is never read back out of the reported
 *  body, so a hook or OSC writer cannot declare its own provenance. */
export type WithAgentStatusObservation = { observation?: AgentStatusObservation }

/** Renderer-local count of ACCEPTED status writes this pane's row has taken. Incremented only by
 *  the store's accept branch, off the row it replaces, and carried through by every field-level
 *  rewrite — so it answers "did the pane report again?", which `updatedAt` cannot, because the
 *  accept rule admits equal timestamps. Lives on the row rather than in a side table so no
 *  teardown path can reset it out from under a reader (STA-4612). Never sent over IPC or
 *  persisted to last-status.json.
 *
 *  Declared here beside the observation facet because both are per-write facets mixed into
 *  `AgentStatusEntry` rather than fields a reporter supplies. */
export type AgentStatusRowFacets = WithAgentStatusObservation & { acceptedStatusSeq?: number }

// ─── THE ORDERING RULE ──────────────────────────────────────────────────────
// `(authorityId, incarnation, revision)` is a total order ONLY within one authorityId.
// A different authorityId means "incomparable", not "older" — the id is regenerated per
// authority instance, so a restarted main, a second machine, and a renderer that parsed
// bytes itself all sequence into disjoint spaces. Consumers must fall back to today's
// timestamp rule across authorities, never mix the two orders.
//
// ─── THE DECAY RULE (neither original review caught this) ───────────────────
// Staleness must be computed against the SAME authority clock that stamped `observedAt`,
// or replicas must decay on LOCAL RECEIPT time instead.
//
// `observedAt` is the authority's wall clock. Today `isExplicitAgentStatusFresh`
// (renderer/src/lib/pane-agent-evidence.ts) computes `rendererNow - entry.updatedAt`, and
// for a MIRRORED REMOTE entry `updatedAt` is the HOST's clock. A host running minutes fast
// makes every remote row look permanently fresh; a host running slow makes them decay on
// arrival. Declaring `observedAt` display-only does NOT fix that — the skew is in the
// subtraction, not in the tiebreak. A replica must either receive the authority's own
// freshness verdict, or stamp its own receipt time and decay against that.
//
// This PR does not fix it. It records the contract at the type so the PR that moves the
// first consumer has something to be correct against.

/** Bounds the per-pane incarnation map. Panes are created for the life of the process;
 *  eviction is safe because `incarnation` is floored by an authority-wide counter (below). */
const OBSERVATION_PANE_STATE_MAX = 1024

/**
 * Assigns ordering metadata for one authority (one main process, one renderer).
 *
 * `revision` is a single authority-wide counter rather than one per pane: it is then
 * strictly increasing for every pane by construction, including a pane whose per-pane
 * state was evicted, so a future consumer can never read a restarted counter as "older".
 *
 * `incarnation` is per pane, floored by an authority-wide counter that `rebind` advances.
 * A pane re-observed after eviction therefore resumes at a value no lower than its last.
 */
export class AgentStatusObservationSequencer {
  private revision = 0
  private incarnationFloor = 0
  private readonly incarnationByPaneKey = new Map<string, number>()

  constructor(private readonly authorityId: string) {}

  getAuthorityId(): string {
    return this.authorityId
  }

  observe(
    paneKey: string,
    args: {
      origin: AgentStatusObservationOrigin
      observedAt: number
      boundary?: boolean
      kind?: AgentStatusObservationKind
    }
  ): AgentStatusObservation {
    this.revision += 1
    return {
      origin: args.origin,
      authorityId: this.authorityId,
      incarnation: this.resolveIncarnation(paneKey),
      revision: this.revision,
      observedAt: args.observedAt,
      ...(args.boundary ? { boundary: true as const } : {}),
      ...(args.kind ? { kind: args.kind } : {})
    }
  }

  /** The pane's PTY was rebound (relaunch, reattach, pane reuse): later observations
   *  describe a different session behind the same key. */
  rebind(paneKey: string): void {
    this.incarnationFloor += 1
    this.incarnationByPaneKey.delete(paneKey)
    this.setIncarnation(paneKey, this.incarnationFloor)
  }

  /** Pane is gone; drop its state. Re-observation after this reads the current floor. */
  forget(paneKey: string): void {
    this.incarnationByPaneKey.delete(paneKey)
  }

  private resolveIncarnation(paneKey: string): number {
    const known = this.incarnationByPaneKey.get(paneKey)
    if (known !== undefined) {
      return known
    }
    this.setIncarnation(paneKey, this.incarnationFloor)
    return this.incarnationFloor
  }

  private setIncarnation(paneKey: string, incarnation: number): void {
    this.incarnationByPaneKey.set(paneKey, incarnation)
    while (this.incarnationByPaneKey.size > OBSERVATION_PANE_STATE_MAX) {
      const oldest = this.incarnationByPaneKey.keys().next().value
      if (oldest === undefined) {
        return
      }
      this.incarnationByPaneKey.delete(oldest)
    }
  }
}

/** Per-instance authority id. Regenerated every process start on purpose: a restarted
 *  authority's revision counter starts over, so its observations must not be comparable
 *  with the ones it emitted before (including any rehydrated from disk). */
export function createAgentStatusAuthorityId(role: string): string {
  return `${role}:${globalThis.crypto.randomUUID()}`
}
