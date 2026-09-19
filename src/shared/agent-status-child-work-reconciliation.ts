// Reconcile one parent's structured child work against the canonical collection.
//
// The provider roster is a full inventory, so this reconciles membership rather than
// applying edits: a task the roster stopped listing leaves the live set. It never
// claims an outcome the channel cannot carry, and it owns only the children its own
// producer admitted — another producer's rows are not its to settle.

import type {
  AgentChildWorkAdmission,
  AgentChildWorkAdmissionResult,
  AgentChildWorkObservationAlias,
  AgentChildWorkObservationFields
} from './agent-status-child-work-admission'
import type {
  AgentChildWorkAliasInput,
  AgentChildWorkAliasRecord
} from './agent-status-child-work-alias'
import {
  AGENT_CHILD_WORK_KINDS,
  agentChildWorkFencesEqual,
  type AgentChildWorkRecord
} from './agent-status-child-work'
import {
  STRUCTURED_CHILD_WORK_MAX_TASKS,
  STRUCTURED_CHILD_WORK_PRODUCER_ID,
  STRUCTURED_CHILD_WORK_SEGMENT_ID,
  type StructuredChildWorkEvidence,
  type StructuredChildWorkObservation
} from './agent-status-child-work-structured-evidence'
import type { AgentStatusStore } from './agent-status-store'
import type { AgentStatusSubject } from './agent-status-subject'

/** The invocation of a structured background child is named by its producer channel;
 *  only a proven revival — the provider reporting a settled id as live again —
 *  advances the generation. */
const INVOCATION_ID = STRUCTURED_CHILD_WORK_SEGMENT_ID

export type StructuredChildWorkReconcileInput = {
  store: AgentStatusStore
  admission: AgentChildWorkAdmission
  parent: AgentStatusSubject
  provider: string
  evidence: StructuredChildWorkEvidence
  observedAt: number
}

export type StructuredChildWorkReconcileOutcome = {
  announced: number
  adopted: number
  resumed: number
  settled: number
  /** Admissions the store or the guards refused, by reason. Never thrown: a refusal
   *  is a fact about one child, not a reason to drop the whole roster. */
  rejected: { childWorkId?: string; providerTaskId: string; reason: string }[]
}

function probeAliases(
  parent: AgentStatusSubject,
  provider: string,
  providerTaskIds: readonly string[]
): AgentChildWorkAliasInput[] {
  const probes: AgentChildWorkAliasInput[] = []
  for (const alias of providerTaskIds) {
    // The alias key carries `kind`, so a reclassified child answers under its old
    // kind alone; probing every kind is what keeps promotion from reminting an id.
    for (const kind of AGENT_CHILD_WORK_KINDS) {
      probes.push({
        parent,
        provider,
        segmentId: STRUCTURED_CHILD_WORK_SEGMENT_ID,
        kind,
        aliasKind: 'task_id',
        alias,
        childWorkId: 'unresolved-child',
        fence: { invocationId: INVOCATION_ID, generation: 0 }
      })
    }
  }
  return probes
}

function observationAlias(providerTaskId: string): AgentChildWorkObservationAlias {
  return {
    segmentId: STRUCTURED_CHILD_WORK_SEGMENT_ID,
    aliasKind: 'task_id',
    alias: providerTaskId
  }
}

function ownedByProducer(child: AgentChildWorkRecord): boolean {
  return (
    child.provenance.source === 'structured-session' &&
    child.provenance.producerId === STRUCTURED_CHILD_WORK_PRODUCER_ID
  )
}

function fields(
  observation: StructuredChildWorkObservation,
  observedAt: number
): AgentChildWorkObservationFields {
  return {
    kind: observation.kind,
    state: observation.state,
    membership: observation.membership,
    // This channel has no failure or cancellation vocabulary, so a settled row
    // records that its outcome was never reported rather than claiming success.
    ...(observation.membership === 'settled' ? { outcome: 'unknown' as const } : {}),
    ...(observation.name !== undefined ? { name: observation.name } : {}),
    ...(observation.description !== undefined ? { description: observation.description } : {}),
    ...(observation.totalTokens !== undefined ? { totalTokens: observation.totalTokens } : {}),
    ...(observation.providerTiming !== undefined
      ? { providerTiming: observation.providerTiming }
      : {}),
    observedAt,
    stoppable: observation.stoppable,
    provenance: { source: 'structured-session', producerId: STRUCTURED_CHILD_WORK_PRODUCER_ID }
  }
}

/** A record's own `observedAt` may not go backwards; a host clock that does must not
 *  cost the child its update. */
function monotonic(observedAt: number, existing: AgentChildWorkRecord | null): number {
  return existing ? Math.max(observedAt, existing.observedAt) : observedAt
}

type AliasResolution = {
  child: AgentChildWorkRecord | null
  ambiguous: boolean
  /** Highest generation any binding for this alias holds, live or retired. A retired
   *  binding outlives the record it named, and must fence a late observation for that
   *  lifetime without banning the provider id forever. */
  highestGeneration: number | null
}

function resolveExisting(
  store: AgentStatusStore,
  bindingsByAlias: ReadonlyMap<string, readonly AgentChildWorkAliasRecord[]>,
  providerTaskId: string
): AliasResolution {
  const bindings = bindingsByAlias.get(providerTaskId) ?? []
  const highestGeneration = bindings.reduce<number | null>(
    (highest, binding) => Math.max(highest ?? 0, binding.fence.generation),
    bindings.length > 0 ? 0 : null
  )
  const candidates = bindings
    .map((binding) => store.getChild(binding.childWorkId))
    .filter((child): child is AgentChildWorkRecord => child !== null && ownedByProducer(child))
  const distinct = new Set(candidates.map((child) => child.childWorkId))
  if (distinct.size > 1) {
    return { child: null, ambiguous: true, highestGeneration }
  }
  return { child: candidates[0] ?? null, ambiguous: false, highestGeneration }
}

function admitObservation(
  input: StructuredChildWorkReconcileInput,
  observation: StructuredChildWorkObservation,
  resolution: AliasResolution
): { result: AgentChildWorkAdmissionResult; operation: 'announced' | 'adopted' | 'resumed' } {
  const { admission, parent, provider } = input
  const existing = resolution.child
  const observedAt = monotonic(input.observedAt, existing)
  const aliases = [observationAlias(observation.providerTaskId)]
  const common = { ...fields(observation, observedAt), parent, provider, aliases }
  if (!existing) {
    // Bindings with no record left are retired lifetimes — a parent this host forgot
    // takes its children with it. Their provider id is free again, under a generation
    // past the retired one so the old binding still fences its own late observations.
    const retired = resolution.highestGeneration
    return {
      operation: 'announced',
      result: admission.announce({
        ...common,
        fence: { invocationId: INVOCATION_ID, generation: retired === null ? 0 : retired + 1 },
        lifetime: retired === null ? 'current' : 'proven-new'
      })
    }
  }
  // Revival first: a settled child reported live again keeps its id and retains the
  // previous invocation's outcome, and `resume` also carries a new classification.
  if (existing.membership === 'settled' && observation.membership === 'live') {
    return {
      operation: 'resumed',
      result: admission.resume({
        ...common,
        childWorkId: existing.childWorkId,
        expectedFence: existing.invocation,
        nextFence: {
          invocationId: existing.invocation.invocationId,
          generation: existing.invocation.generation + 1
        }
      })
    }
  }
  if (existing.kind !== observation.kind) {
    return {
      operation: 'adopted',
      result: admission.adopt({
        ...common,
        childWorkId: existing.childWorkId,
        expectedFence: existing.invocation
      })
    }
  }
  return {
    operation: 'announced',
    result: admission.announce({ ...common, fence: existing.invocation, lifetime: 'current' })
  }
}

function settleAbsent(
  input: StructuredChildWorkReconcileInput,
  child: AgentChildWorkRecord,
  outcome: StructuredChildWorkReconcileOutcome
): void {
  const aliases = input.store
    .getAliasesForChild(child.childWorkId)
    .filter(
      (alias) =>
        alias.aliasKind === 'task_id' &&
        alias.segmentId === STRUCTURED_CHILD_WORK_SEGMENT_ID &&
        agentChildWorkFencesEqual(alias.fence, child.invocation)
    )
    .map((alias) => observationAlias(alias.alias))
  if (aliases.length === 0) {
    outcome.rejected.push({
      childWorkId: child.childWorkId,
      providerTaskId: '',
      reason: 'unbound-child'
    })
    return
  }
  const result = input.admission.announce({
    ...fields(
      {
        providerTaskId: aliases[0].alias,
        kind: child.kind,
        // The roster stopped listing it; that is loss of live membership, not an
        // outcome and not proof of exit.
        state: 'idle',
        membership: 'settled',
        stoppable: false,
        ...(child.name !== undefined ? { name: child.name } : {}),
        ...(child.description !== undefined ? { description: child.description } : {}),
        ...(child.totalTokens !== undefined ? { totalTokens: child.totalTokens } : {}),
        ...(child.providerTiming !== undefined ? { providerTiming: child.providerTiming } : {})
      },
      monotonic(input.observedAt, child)
    ),
    parent: input.parent,
    provider: input.provider,
    aliases,
    fence: child.invocation,
    lifetime: 'current'
  })
  if (result.accepted) {
    outcome.settled += 1
    return
  }
  outcome.rejected.push({
    childWorkId: child.childWorkId,
    providerTaskId: aliases[0].alias,
    reason: result.reason
  })
}

/**
 * Apply one decoded roster. The parent must already be published: the store refuses a
 * child whose parent it does not hold, which is what keeps this producer from
 * inventing a parent of its own.
 */
export function reconcileStructuredChildWork(
  input: StructuredChildWorkReconcileInput
): StructuredChildWorkReconcileOutcome {
  const outcome: StructuredChildWorkReconcileOutcome = {
    announced: 0,
    adopted: 0,
    resumed: 0,
    settled: 0,
    rejected: []
  }
  const { observations } = input.evidence
  const bindings = input.store.resolveChildAliases(
    probeAliases(
      input.parent,
      input.provider,
      observations.map((observation) => observation.providerTaskId)
    )
  )
  const bindingsByAlias = new Map<string, AgentChildWorkAliasRecord[]>()
  for (const binding of bindings) {
    const entry = bindingsByAlias.get(binding.alias) ?? []
    entry.push(binding)
    bindingsByAlias.set(binding.alias, entry)
  }
  const owned = input.store.getChildren(input.parent).filter(ownedByProducer)
  const matched = new Set<string>()
  for (const observation of observations) {
    const resolution = resolveExisting(input.store, bindingsByAlias, observation.providerTaskId)
    const child = resolution.child
    if (resolution.ambiguous) {
      outcome.rejected.push({
        providerTaskId: observation.providerTaskId,
        reason: 'ambiguous'
      })
      continue
    }
    if (!child && owned.length + outcome.announced >= STRUCTURED_CHILD_WORK_MAX_TASKS) {
      outcome.rejected.push({
        providerTaskId: observation.providerTaskId,
        reason: 'ingestion-limit'
      })
      continue
    }
    const { result, operation } = admitObservation(input, observation, resolution)
    if (!result.accepted) {
      outcome.rejected.push({
        ...(child ? { childWorkId: child.childWorkId } : {}),
        providerTaskId: observation.providerTaskId,
        reason: result.reason
      })
      continue
    }
    matched.add(result.childWorkId)
    outcome[operation] += 1
  }
  for (const child of owned) {
    if (child.membership === 'live' && !matched.has(child.childWorkId)) {
      settleAbsent(input, child, outcome)
    }
  }
  return outcome
}
