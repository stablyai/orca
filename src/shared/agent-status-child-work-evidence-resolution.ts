// Finding the record a provider handle names, among the records one structured producer owns.

import type { AgentChildWorkObservationAlias } from './agent-status-child-work-admission'
import type {
  AgentChildWorkAliasInput,
  AgentChildWorkAliasKind,
  AgentChildWorkAliasRecord
} from './agent-status-child-work-alias'
import {
  AGENT_CHILD_WORK_KINDS,
  agentChildWorkFencesEqual,
  type AgentChildWorkProvenance,
  type AgentChildWorkRecord
} from './agent-status-child-work'
import type { AgentChildWorkEvidenceHandle } from './agent-status-child-work-evidence'
import type { AgentStatusStore } from './agent-status-store'
import { agentStatusSubjectsEqual, type AgentStatusSubject } from './agent-status-subject'

/** One producer per structured session: its provider's lane. The segment scopes its aliases, so
 *  a handle is unique per parent and provider without being unique across producers. */
export const STRUCTURED_CHILD_WORK_PRODUCER_ID = 'structured-session-child-work'
const SEGMENT_ID = STRUCTURED_CHILD_WORK_PRODUCER_ID
/** A run is named in the provider's own terms: a task runs under its spawn call, a thread under
 *  its turn. The kinds stay apart so a turn id can never pass for a spawn call. */
const RUN_ALIAS_KIND_BY_ID_KIND = {
  task_id: 'tool_use_id',
  thread_id: 'turn_id'
} as const satisfies Record<AgentChildWorkEvidenceHandle['idKind'], AgentChildWorkAliasKind>
const RUN_ALIAS_KINDS: ReadonlySet<AgentChildWorkAliasKind> = new Set(
  Object.values(RUN_ALIAS_KIND_BY_ID_KIND)
)

export const STRUCTURED_CHILD_WORK_PROVENANCE: AgentChildWorkProvenance = {
  source: 'structured-session',
  producerId: STRUCTURED_CHILD_WORK_PRODUCER_ID
}

export type AgentChildWorkEvidenceScope = {
  store: AgentStatusStore
  parent: AgentStatusSubject
  provider: string
}

export type AgentChildWorkHandleResolution = {
  child: AgentChildWorkRecord | null
  ambiguous: boolean
  /** Highest generation any binding for the handle holds, live or retired. A retired binding
   *  outlives the record it named and must fence that lifetime's late evidence, without banning
   *  the provider id for ever. */
  highestGeneration: number | null
}

/** Only this producer's records are its to change; another producer's rows are not. */
export function isOwnedStructuredChildWork(
  scope: AgentChildWorkEvidenceScope,
  child: AgentChildWorkRecord
): boolean {
  return (
    child.provenance.source === STRUCTURED_CHILD_WORK_PROVENANCE.source &&
    child.provenance.producerId === STRUCTURED_CHILD_WORK_PRODUCER_ID &&
    child.provider === scope.provider &&
    agentStatusSubjectsEqual(child.parent, scope.parent)
  )
}

export function ownedStructuredChildWork(
  scope: AgentChildWorkEvidenceScope
): AgentChildWorkRecord[] {
  return scope.store
    .getChildren(scope.parent)
    .filter((child) => isOwnedStructuredChildWork(scope, child))
}

/** The aliases one handle registers: the stable id, and the run's own handle when it has one. */
export function agentChildWorkHandleAliases(
  handle: AgentChildWorkEvidenceHandle
): AgentChildWorkObservationAlias[] {
  return [
    { segmentId: SEGMENT_ID, aliasKind: handle.idKind, alias: handle.id },
    ...(handle.runId !== undefined && handle.runId !== handle.id
      ? [
          {
            segmentId: SEGMENT_ID,
            aliasKind: RUN_ALIAS_KIND_BY_ID_KIND[handle.idKind],
            alias: handle.runId
          }
        ]
      : [])
  ]
}

function probes(
  scope: AgentChildWorkEvidenceScope,
  aliasKinds: readonly AgentChildWorkAliasKind[],
  alias: string
): AgentChildWorkAliasInput[] {
  // The alias key carries `kind`, so a reclassified child answers under its old kind alone;
  // probing every kind is what keeps a reclassification from minting a second child.
  return aliasKinds.flatMap((aliasKind) =>
    AGENT_CHILD_WORK_KINDS.map((kind) => ({
      parent: scope.parent,
      provider: scope.provider,
      segmentId: SEGMENT_ID,
      kind,
      aliasKind,
      alias,
      childWorkId: 'unresolved-child',
      fence: { invocationId: 'unresolved', generation: 0 }
    }))
  )
}

/** Null when the handle cannot be an alias at all (the store's alias bounds refuse it). */
export function resolveAgentChildWorkHandle(
  scope: AgentChildWorkEvidenceScope,
  aliasKinds: readonly AgentChildWorkAliasKind[],
  alias: string
): AgentChildWorkHandleResolution | null {
  let bindings: AgentChildWorkAliasRecord[]
  try {
    bindings = scope.store.resolveChildAliases(probes(scope, aliasKinds, alias))
  } catch {
    return null
  }
  let highestGeneration: number | null = null
  const owned = new Map<string, AgentChildWorkRecord>()
  for (const binding of bindings) {
    highestGeneration = Math.max(highestGeneration ?? 0, binding.fence.generation)
    const child = scope.store.getChild(binding.childWorkId)
    if (child && isOwnedStructuredChildWork(scope, child)) {
      owned.set(child.childWorkId, child)
    }
  }
  const [child] = owned.values()
  return owned.size > 1
    ? { child: null, ambiguous: true, highestGeneration }
    : { child: child ?? null, ambiguous: false, highestGeneration }
}

/** The owner a handle id names, by its stable id or by the spawn call it runs under. */
export function resolveAgentChildWorkOwner(
  scope: AgentChildWorkEvidenceScope,
  ownerId: string
): string | undefined {
  const resolution = resolveAgentChildWorkHandle(
    scope,
    ['task_id', 'thread_id', 'tool_use_id'],
    ownerId
  )
  return resolution?.child?.childWorkId
}

function isStableAliasKind(
  kind: AgentChildWorkAliasKind
): kind is AgentChildWorkEvidenceHandle['idKind'] {
  return kind === 'task_id' || kind === 'thread_id'
}

/** The handles a record answers to for its current run. */
export function currentAgentChildWorkAliases(
  scope: AgentChildWorkEvidenceScope,
  child: AgentChildWorkRecord
): {
  stable?: AgentChildWorkEvidenceHandle
  stableId?: string
  runId?: string
  aliases: AgentChildWorkObservationAlias[]
} {
  const current = scope.store
    .getAliasesForChild(child.childWorkId)
    .filter((alias) => agentChildWorkFencesEqual(alias.fence, child.invocation))
  let stable: AgentChildWorkEvidenceHandle | undefined
  for (const alias of current) {
    if (!stable && isStableAliasKind(alias.aliasKind)) {
      stable = { idKind: alias.aliasKind, id: alias.alias }
    }
  }
  return {
    ...(stable ? { stable } : {}),
    stableId: stable?.id,
    runId: current.find((alias) => RUN_ALIAS_KINDS.has(alias.aliasKind))?.alias,
    aliases: current.map((alias) => ({
      segmentId: alias.segmentId,
      aliasKind: alias.aliasKind,
      alias: alias.alias
    }))
  }
}

/** A run handle this child answered to before its current run: evidence from a run that is over. */
export function isPreviousAgentChildWorkRun(
  scope: AgentChildWorkEvidenceScope,
  child: AgentChildWorkRecord,
  runId: string
): boolean {
  return scope.store
    .getAliasesForChild(child.childWorkId)
    .some(
      (alias) =>
        RUN_ALIAS_KINDS.has(alias.aliasKind) &&
        alias.alias === runId &&
        !agentChildWorkFencesEqual(alias.fence, child.invocation)
    )
}
