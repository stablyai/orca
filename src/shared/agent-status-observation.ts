// Stamp evidence provenance at ingress: hook and byte-derived rows use distinct clocks/order spaces. Reporters cannot supply their own provenance.

import { createNonSecureContextUuid } from './non-secure-context-uuid'

/** Where the evidence for a status row came from — the ingress, not the transport.
 *  A hook event relayed over SSH is still `hook`; the relay is a carrier. */
export const AGENT_STATUS_OBSERVATION_ORIGINS = [
  /** Provider hook event (loopback HTTP or relayed), run through a provider normalizer. */
  'hook',
  /** In-band status parsed out of PTY bytes: OSC 9999 payloads or OSC 7501 program status. */
  'osc',
  /** Inferred from a terminal title. The weakest evidence Orca acts on. */
  'title',
  /** Derived from the pane's own process/output evidence (e.g. Command Code output seeds). */
  'process',
  /** Seeded when Orca launched the agent itself, before any provider signal. */
  'launch',
  /** Stamped by orchestration dispatch rather than by the agent. */
  'orchestration',
  /** Projected by the structured session host from a session's journal; no PTY, no hook. */
  'structured'
] as const
export type AgentStatusObservationOrigin = (typeof AGENT_STATUS_OBSERVATION_ORIGINS)[number]

/** transition asserts a state change; snapshot is repaint/replay, never a new-turn proof; identity-only refreshes resume identity with placeholder status fields (providerSessionOnly). */
export type AgentStatusObservationKind = 'transition' | 'snapshot' | 'identity-only'

export type AgentStatusObservation = {
  origin: AgentStatusObservationOrigin
  /** Which component sequenced this observation. Opaque; see the ordering rule below. */
  authorityId: string
  /** Bumped when the pane/PTY behind this key is rebound. Non-decreasing per pane. */
  incarnation: number
  /** Monotonic within one authority; compare, never count: other panes share the counter and leave gaps. */
  revision: number
  /** The AUTHORITY's clock when it sequenced this observation — not the reader's. */
  observedAt: number
  /** Use each provider's isNewTurnEvent for user-turn boundaries; raw event-name lists stranded other providers in the retired-pane gate (#14626). */
  boundary?: true
  kind?: AgentStatusObservationKind
}

/** Optional for older hosts, hydration and unstamped ingress. Keep it out of AgentStatusPayload: only trusted ingress may stamp provenance, never hook/OSC body writers. */
export type WithAgentStatusObservation = { observation?: AgentStatusObservation }

/** Replica-local receipt advances only for new authority evidence, never repeated snapshots. Freshness uses this clock to avoid host skew; absent locally, never persisted or sent over IPC. */
export type MirroredEvidenceReceipt = { mirroredEvidenceReceivedAt?: number }

/** Count accepted writes on the row because equal updatedAt values may still be accepted. Preserve through field rewrites so teardown cannot reset readers via a side table (STA-4612). Renderer-only, never IPC/persisted. */
export type AgentStatusRowFacets = WithAgentStatusObservation &
  MirroredEvidenceReceipt & { acceptedStatusSeq?: number }

// Order incarnation/revision only within one authorityId; restarts/machines/byte parsers are incomparable and use the timestamp fallback.
// Decay against the stamping authority's clock or replica-local receipt, never cross-machine subtraction. Carry receipt across repeated snapshots.
// A published host freshness verdict cannot age after contact loss; local receipt keeps decaying without new frames.

/** Bound pane state; authority-wide incarnation floors preserve order after eviction. */
const OBSERVATION_PANE_STATE_MAX = 1024

/** Authority-wide revisions stay increasing after per-pane eviction; rebind advances the incarnation floor so reobserved panes never move backwards. */
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

/** Regenerate IDs each process start: reset revision counters must not compare with old or hydrated observations. */
export function createAgentStatusAuthorityId(role: string): string {
  return `${role}:${createNonSecureContextUuid()}`
}
