import { collectAgentTitleEvidence } from './agent-title-evidence'
import { PANE_AGENT_EVIDENCE_SOURCES } from './pane-agent-evidence-sources'
import type {
  PaneAgentEvidence,
  PaneAgentIdentity,
  PaneAgentIdentityInput,
  PaneAgentRunKey
} from './pane-agent-identity-resolver'
import type { PaneAgentEvidenceSource } from './pane-agent-evidence-sources'
import type { TuiAgent } from './tui-agent'

/**
 * Canonical pane identity ranking. All adapters, including the compatibility resolver, delegate to
 * this implementation so source precedence, ambiguity, and run eligibility cannot drift.
 */

/**
 * Whether the execution authority proved at least one identity-bearing source for this pane.
 * Computed from evidence presence, never from `platform`, `isRemote`, or OS: a remote pane with a
 * host-stamped hook is covered; a local pane with only a title is uncovered.
 */
export type PaneAgentCoverage = 'covered' | 'uncovered'

/**
 * Host-stamped proof that a recognized agent process is the pane's foreground process.
 *
 * A process NAME is not a PID-reuse-safe identity, so a bare foreground read never enters the
 * covered process rung. `processIncarnation` is an opaque token the execution host derives from
 * the selected PID plus start/creation time (or an equivalent platform-native identity); the raw
 * tuple never crosses the renderer/remote wire. The host emits no proof when the start identity
 * is unavailable or ambiguous, so that pane reads `uncovered` rather than guessed.
 */
export type ForegroundProcessProof = {
  agent: TuiAgent
  /** Opaque host-derived PID+start-time token. Compared for equality only, never decoded. */
  processIncarnation: string
  ptyIncarnationId?: string
  /** The execution authority that stamped the proof (see agent-status-observation.ts). */
  authorityId: string
  /** Age on the AUTHORITY's clock at capture. Replicas decay from this plus `validForMs`,
   *  never by subtracting a host wall clock from a local `Date.now()`. */
  capturedAgeMs: number
  validForMs: number
}

/**
 * Positive evidence that a pane/process was REPLACED, required before any consumer may advance a
 * pane incarnation. A retired-pane `restart` disposition, an accepted send, an ordinary provider
 * turn boundary, a title change, a transport loss, or a renderer-only foreground change is never
 * one of these. Defined here so the rebind-gate wave has a contract to be correct against; no
 * sequencer call site consumes it yet.
 */
export type PaneReplacementProof =
  | { kind: 'accepted-launch'; launchToken: string; ptyIncarnationId: string }
  | { kind: 'process-replacement'; processIncarnation: string; authorityId: string }
  | { kind: 'provider-session-attach'; providerSessionId: string }

/**
 * The optional wire object a host will publish alongside `agentIdentity` after capability
 * negotiation (host-publisher wave, not now). All fields bounded and JSON-safe; old peers ignore
 * it. Never inferred from the bare `agentIdentity` string.
 */
export type PaneAgentIdentityEvidenceWire = {
  source: PaneAgentEvidenceSource
  coverage: PaneAgentCoverage
  authorityId?: string
  incarnation?: number
  freshness?: { capturedAgeMs: number; validForMs: number }
  /** Marks the scoped host-published title-only best-effort route (hand-started WSL panes).
   *  Counted separately, `unverifiable` for liveness, and never relabeled as covered proof. */
  titleOnlyActionFallback?: true
}

export type CanonicalPaneAgentIdentityInput = {
  hookAgent?: TuiAgent | null
  hookIsLive?: boolean
  hookRun?: PaneAgentRunKey
  /** A distinct completed-hook signal for callers that hold live and completed rows separately
   *  (the tab ladder does); `hookAgent` + `hookIsLive: false` remains the single-slot spelling. */
  completedHookAgent?: TuiAgent | null
  completedHookRun?: PaneAgentRunKey
  launchAgent?: TuiAgent | null
  launchRun?: PaneAgentRunKey
  /**
   * Foreground process NAME as currently read. Without a fresh `processProof` this is a weak
   * hint: it neither enters the covered process rung nor makes the pane covered.
   */
  foregroundAgent?: TuiAgent | null
  processProof?: ForegroundProcessProof | null
  sleepingSessionAgent?: TuiAgent | null
  sleepingRun?: PaneAgentRunKey
  /** Tab-level display fallback only; ignored unless `allowSibling` opts in. */
  siblingAgent?: TuiAgent | null
  /** Additional tab-level sibling observations retained for ambiguity checking. */
  siblingAgents?: readonly TuiAgent[]
  allowSibling?: boolean
  title?: string | null
  currentRun?: PaneAgentRunKey
  minimumSource?: PaneAgentEvidenceSource
  /**
   * The caller's CURRENT ladder result, preserved verbatim while the pane is uncovered. The
   * uncovered lane is a temporary compatibility lane, not a new host-specific ranking; absent a
   * fallback, an uncovered pane answers from title evidence alone, marked title-only.
   */
  uncoveredFallback?: { agent: TuiAgent | null; titleOnly?: boolean }
}

export type CanonicalPaneAgentIdentity = {
  agent: TuiAgent | null
  source: PaneAgentEvidenceSource | null
  coverage: PaneAgentCoverage
  /** True when the answer was derived from a parsed title (the uncovered/title-only marking). */
  titleOnly: boolean
  ambiguousAt?: PaneAgentEvidenceSource
  supersededSources: readonly PaneAgentEvidenceSource[]
}

/** Authority order, strongest first. This is the only place precedence is expressed. */
const SOURCE_RANK: readonly PaneAgentEvidenceSource[] = PANE_AGENT_EVIDENCE_SOURCES

/** Exported for the source/rank drift ratchet; the rank is the canonical source list itself. */
export const PANE_AGENT_SOURCE_RANK = SOURCE_RANK

/** Reject an unrecognised source instead of silently dropping it from the ranking loop. */
function sourceRankIndex(source: PaneAgentEvidenceSource): number {
  const index = SOURCE_RANK.indexOf(source)
  if (index === -1) {
    throw new Error(`Unknown pane-agent evidence source: ${String(source)}`)
  }
  return index
}

/** Run keys only supersede evidence from the same authority; unknown authorities stay eligible. */
function isPaneAgentRunEligible(
  run: PaneAgentRunKey | undefined,
  currentRun: PaneAgentRunKey | undefined
): boolean {
  return (
    run === undefined ||
    currentRun === undefined ||
    run.authorityId !== currentRun.authorityId ||
    run.incarnation === currentRun.incarnation
  )
}

/** Shared evidence ranking primitive used by every pane-identity adapter. */
export function resolveCanonicalPaneAgentEvidence<A extends string = TuiAgent>(
  input: PaneAgentIdentityInput<A>
): PaneAgentIdentity<A> {
  const superseded: PaneAgentEvidenceSource[] = []
  const floor = input.minimumSource ? sourceRankIndex(input.minimumSource) : Number.MAX_SAFE_INTEGER
  const eligible = input.evidence.filter((item) => {
    if (item.source === 'sibling' && input.allowSibling !== true) {
      return false
    }
    if (sourceRankIndex(item.source) > floor) {
      return false
    }
    if (isPaneAgentRunEligible(item.run, input.currentRun)) {
      return true
    }
    superseded.push(item.source)
    return false
  })

  for (const source of SOURCE_RANK) {
    const matches = eligible.filter((item) => item.source === source)
    if (matches.length === 0) {
      continue
    }
    const agents = new Set(matches.map((item) => item.agent))
    if (agents.size > 1) {
      return { agent: null, source: null, ambiguousAt: source, supersededSources: superseded }
    }
    return { agent: matches[0].agent, source, supersededSources: superseded }
  }
  return { agent: null, source: null, supersededSources: superseded }
}

/** Freshness is judged on the authority's own clock: age at capture against its TTL. */
export function isForegroundProcessProofFresh(proof: ForegroundProcessProof): boolean {
  return (
    Number.isFinite(proof.capturedAgeMs) &&
    Number.isFinite(proof.validForMs) &&
    proof.capturedAgeMs >= 0 &&
    proof.validForMs > 0 &&
    proof.capturedAgeMs <= proof.validForMs
  )
}

/** A proof only carries identity for the agent it names; a name mismatch is no proof at all. */
function processEvidenceFromProof(
  input: CanonicalPaneAgentIdentityInput
): PaneAgentEvidence<TuiAgent> | null {
  const proof = input.processProof
  if (!proof || !isForegroundProcessProofFresh(proof)) {
    return null
  }
  if (input.foregroundAgent && input.foregroundAgent !== proof.agent) {
    return null
  }
  return { source: 'process', agent: proof.agent }
}

export function resolveCanonicalPaneAgentIdentity(
  input: CanonicalPaneAgentIdentityInput
): CanonicalPaneAgentIdentity {
  const processEvidence = processEvidenceFromProof(input)
  // Coverage comes from authority-bearing sources that are still eligible for this run. A stale
  // hook/launch row can remain in the input after a pane is replaced; it must not make a title-only
  // answer look covered to a future action consumer.
  const covered = Boolean(
    (input.hookAgent && isPaneAgentRunEligible(input.hookRun, input.currentRun)) ||
    (input.completedHookAgent &&
      isPaneAgentRunEligible(input.completedHookRun, input.currentRun)) ||
    processEvidence ||
    (input.launchAgent && isPaneAgentRunEligible(input.launchRun, input.currentRun)) ||
    (input.sleepingSessionAgent && isPaneAgentRunEligible(input.sleepingRun, input.currentRun))
  )
  // Keep stale evidence in the resolver so diagnostics still report which source was superseded,
  // even when it no longer qualifies the pane as covered.
  const hasAuthorityEvidence = Boolean(
    input.hookAgent ||
    input.completedHookAgent ||
    processEvidence ||
    input.launchAgent ||
    input.sleepingSessionAgent
  )
  const titleEvidence = input.title ? collectAgentTitleEvidence(input.title) : null
  const titleAgent = titleEvidence?.agent ?? null

  if (!hasAuthorityEvidence) {
    if (input.uncoveredFallback) {
      const agent = input.uncoveredFallback.agent
      // A legacy title parser may have picked the first token from an ambiguous or
      // free-text-only title. Do not let that compatibility value bypass the canonical
      // ambiguity fence when the caller marks it as title-only evidence.
      const rejectTitleFallback =
        input.uncoveredFallback.titleOnly === true &&
        ((titleEvidence?.reason === 'free-text-only' &&
          (titleEvidence.freeTextNames?.length ?? 0) > 1) ||
          titleEvidence?.reason === 'conflicting-anchored-names' ||
          titleEvidence?.reason === 'conflicting-vendor-markers')
      if (rejectTitleFallback) {
        return {
          agent: null,
          source: null,
          coverage: 'uncovered',
          titleOnly: false,
          ...(titleEvidence?.reason === 'free-text-only' ? {} : { ambiguousAt: 'title' as const }),
          supersededSources: []
        }
      }
      const titleOnly =
        input.uncoveredFallback.titleOnly ?? (agent !== null && agent === titleAgent)
      return {
        agent,
        source: agent === null ? null : titleOnly ? 'title' : null,
        coverage: 'uncovered',
        titleOnly,
        supersededSources: []
      }
    }
    const siblingEvidence = [
      ...(input.siblingAgent ? [{ source: 'sibling' as const, agent: input.siblingAgent }] : []),
      ...(input.siblingAgents?.map((agent) => ({ source: 'sibling' as const, agent })) ?? []),
      ...(titleAgent ? [{ source: 'title' as const, agent: titleAgent }] : [])
    ]
    const siblingResolved = resolveCanonicalPaneAgentEvidence<TuiAgent>({
      evidence: siblingEvidence,
      allowSibling: input.allowSibling,
      minimumSource: input.minimumSource
    })
    return {
      agent: siblingResolved.agent,
      source: siblingResolved.source,
      coverage: 'uncovered',
      titleOnly: siblingResolved.source === 'title',
      ...(siblingResolved.ambiguousAt ? { ambiguousAt: siblingResolved.ambiguousAt } : {}),
      supersededSources: siblingResolved.supersededSources
    }
  }

  const resolved = resolveCanonicalPaneAgentEvidence<TuiAgent>({
    evidence: [
      ...(input.hookAgent
        ? [
            {
              source: input.hookIsLive ? ('live-hook' as const) : ('completed-hook' as const),
              agent: input.hookAgent,
              ...(input.hookRun ? { run: input.hookRun } : {})
            }
          ]
        : []),
      ...(input.completedHookAgent
        ? [
            {
              source: 'completed-hook' as const,
              agent: input.completedHookAgent,
              ...(input.completedHookRun ? { run: input.completedHookRun } : {})
            }
          ]
        : []),
      ...(processEvidence ? [processEvidence] : []),
      ...(input.launchAgent
        ? [
            {
              source: 'launch' as const,
              agent: input.launchAgent,
              ...(input.launchRun ? { run: input.launchRun } : {})
            }
          ]
        : []),
      ...(input.sleepingSessionAgent
        ? [
            {
              source: 'sleeping-session' as const,
              agent: input.sleepingSessionAgent,
              ...(input.sleepingRun ? { run: input.sleepingRun } : {})
            }
          ]
        : []),
      ...(input.siblingAgent ? [{ source: 'sibling' as const, agent: input.siblingAgent }] : []),
      ...(input.siblingAgents?.map((agent) => ({ source: 'sibling' as const, agent })) ?? []),
      ...(titleAgent ? [{ source: 'title' as const, agent: titleAgent }] : [])
    ],
    currentRun: input.currentRun,
    minimumSource: input.minimumSource,
    allowSibling: input.allowSibling
  })
  return {
    agent: resolved.agent,
    source: resolved.source,
    coverage: covered ? 'covered' : 'uncovered',
    titleOnly: resolved.source === 'title',
    ...(resolved.ambiguousAt ? { ambiguousAt: resolved.ambiguousAt } : {}),
    supersededSources: resolved.supersededSources
  }
}

/** Projects the host-local sidecar onto the optional wire shape. Returns undefined when there is
 *  nothing to publish — absence stays absence, and a bare `agentIdentity` with no sidecar is
 *  never treated as covered proof by any consumer. */
export function buildPaneAgentIdentityEvidenceWire(
  identity: CanonicalPaneAgentIdentity,
  run?: PaneAgentRunKey,
  freshness?: { capturedAgeMs: number; validForMs: number }
): PaneAgentIdentityEvidenceWire | undefined {
  if (identity.agent === null || identity.source === null) {
    return undefined
  }
  return {
    source: identity.source,
    coverage: identity.coverage,
    ...(run ? { authorityId: run.authorityId, incarnation: run.incarnation } : {}),
    ...(freshness ? { freshness } : {}),
    ...(identity.coverage === 'uncovered' && identity.titleOnly
      ? { titleOnlyActionFallback: true as const }
      : {})
  }
}
