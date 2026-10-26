// One evidence edge about one child, turned into the admission request that records it.

import type {
  AgentChildWorkAdmission,
  AgentChildWorkAdmissionResult,
  AgentChildWorkObservationFields
} from './agent-status-child-work-admission'
import type {
  AgentChildWorkOperation,
  AgentChildWorkOutcome,
  AgentChildWorkOutcomeBasis,
  AgentChildWorkRecord
} from './agent-status-child-work'
import type { AgentChildWorkLiveObservation } from './agent-status-child-work-evidence'
import {
  agentChildWorkHandleAliases,
  currentAgentChildWorkAliases,
  isPreviousAgentChildWorkRun,
  resolveAgentChildWorkHandle,
  resolveAgentChildWorkOwner,
  STRUCTURED_CHILD_WORK_PROVENANCE,
  type AgentChildWorkEvidenceScope
} from './agent-status-child-work-evidence-resolution'

/** A child's first run, matching the provider roster's first attempt. */
const FIRST_GENERATION = 1

export type AgentChildWorkReconcileOutcome = {
  admitted: number
  settled: number
  removed: number
  /** Refusals are facts about one child, never a reason to drop the rest of the evidence. */
  rejected: { handleId: string; reason: string }[]
}

export type AgentChildWorkEvidenceContext = AgentChildWorkEvidenceScope & {
  admission: AgentChildWorkAdmission
  outcome: AgentChildWorkReconcileOutcome
}

function counted(
  ctx: AgentChildWorkEvidenceContext,
  handleId: string,
  result: AgentChildWorkAdmissionResult,
  key: 'admitted' | 'settled'
): void {
  if (result.accepted) {
    ctx.outcome[key] += 1
  } else {
    ctx.outcome.rejected.push({ handleId, reason: result.reason })
  }
}

/** An `open` operation ends on its own edge; a `reported` one lasts until the next report. */
function nextOperation(
  reported: AgentChildWorkOperation | null | undefined,
  current: AgentChildWorkOperation | undefined
): AgentChildWorkOperation | undefined {
  if (reported === undefined) {
    return current
  }
  if (reported === null) {
    return current?.basis === 'open' ? undefined : current
  }
  return reported
}

/** Resolve a handle as the current run (including no stored handle), an ended run or a new provider run. */
export function agentChildWorkRunVerdict(
  ctx: AgentChildWorkEvidenceContext,
  existing: AgentChildWorkRecord,
  runId: string | undefined
): 'current' | 'previous' | 'new' {
  const current = currentAgentChildWorkAliases(ctx, existing).runId
  if (runId === undefined || runId === current) {
    return 'current'
  }
  if (isPreviousAgentChildWorkRun(ctx, existing, runId)) {
    return 'previous'
  }
  return current === undefined ? 'current' : 'new'
}

/** Pass only this edge's facts: admission retains labels/tokens and same-run owner/message. prior names the current run only; new runs start bare. */
function liveFields(
  ctx: AgentChildWorkEvidenceContext,
  child: AgentChildWorkLiveObservation,
  observedAt: number,
  existing: AgentChildWorkRecord | null,
  prior: AgentChildWorkRecord | null
): AgentChildWorkObservationFields {
  // A record's own clock never runs backwards; a host clock that does must not cost the update.
  const at = existing ? Math.max(observedAt, existing.observedAt) : observedAt
  const owner =
    child.ownerId === undefined ? undefined : resolveAgentChildWorkOwner(ctx, child.ownerId)
  const operation = nextOperation(child.operation, prior?.operation)
  return {
    kind: child.kind,
    state: child.state,
    membership: 'live',
    ...(child.name !== undefined ? { name: child.name } : {}),
    ...(child.description !== undefined ? { description: child.description } : {}),
    ...(child.agentType !== undefined ? { agentType: child.agentType } : {}),
    ...(child.totalTokens !== undefined ? { totalTokens: child.totalTokens } : {}),
    ...(owner !== undefined ? { parentChildWorkId: owner } : {}),
    residency: child.residency,
    ...(operation ? { operation } : {}),
    ...(child.lastMessage !== undefined ? { lastMessage: child.lastMessage } : {}),
    observedAt: at,
    stoppable: child.stoppable,
    provenance: STRUCTURED_CHILD_WORK_PROVENANCE
  }
}

export function applyAgentChildWorkLive(
  ctx: AgentChildWorkEvidenceContext,
  child: AgentChildWorkLiveObservation,
  observedAt: number,
  restart: boolean
): void {
  const { handle } = child
  const resolution = resolveAgentChildWorkHandle(ctx, [handle.idKind], handle.id)
  if (!resolution || resolution.ambiguous) {
    ctx.outcome.rejected.push({ handleId: handle.id, reason: resolution ? 'ambiguous' : 'invalid' })
    return
  }
  const existing = resolution.child
  const request = { parent: ctx.parent, provider: ctx.provider }
  const aliases = agentChildWorkHandleAliases(handle)
  if (!existing) {
    // Retired bindings outlive removed records and fence late evidence; reuse IDs only at a later generation.
    const retired = resolution.highestGeneration
    const fence = {
      invocationId: handle.runId ?? handle.id,
      generation: retired === null ? FIRST_GENERATION : retired + 1
    }
    const result = ctx.admission.announce({
      ...liveFields(ctx, child, observedAt, null, null),
      ...request,
      aliases,
      fence,
      lifetime: retired === null ? 'current' : 'proven-new'
    })
    counted(ctx, handle.id, result, 'admitted')
    return
  }
  const run = agentChildWorkRunVerdict(ctx, existing, handle.runId)
  if (run === 'previous') {
    return
  }
  // A different spawn call or an explicit start after settlement proves a new run.
  if (run === 'new' || (existing.membership === 'settled' && restart)) {
    const result = ctx.admission.resume({
      // A reclassification lands on the next edge: resume keeps the kind its bindings carry.
      ...liveFields(ctx, { ...child, kind: existing.kind }, observedAt, existing, null),
      ...request,
      childWorkId: existing.childWorkId,
      expectedFence: existing.invocation,
      nextFence: {
        invocationId: handle.runId ?? existing.invocation.invocationId,
        generation: existing.invocation.generation + 1
      },
      aliases
    })
    counted(ctx, handle.id, result, 'admitted')
    return
  }
  if (existing.membership === 'settled') {
    // Late evidence for a run that already ended.
    return
  }
  const fields = { ...liveFields(ctx, child, observedAt, existing, existing), ...request, aliases }
  const result =
    existing.kind !== child.kind
      ? ctx.admission.adopt({
          ...fields,
          childWorkId: existing.childWorkId,
          expectedFence: existing.invocation
        })
      : ctx.admission.announce({ ...fields, fence: existing.invocation, lifetime: 'current' })
  counted(ctx, handle.id, result, 'admitted')
}

export function settleAgentChildWork(
  ctx: AgentChildWorkEvidenceContext,
  existing: AgentChildWorkRecord,
  outcome: AgentChildWorkOutcome,
  observedAt: number,
  reported: {
    lastMessage?: string
    totalTokens?: number
    basis?: AgentChildWorkOutcomeBasis
  } = {}
): void {
  const current = currentAgentChildWorkAliases(ctx, existing)
  const handleId = current.stableId ?? existing.childWorkId
  if (current.aliases.length === 0) {
    ctx.outcome.rejected.push({ handleId, reason: 'unbound-child' })
    return
  }
  // Admission keeps what the record already knows; the ending adds only what it reported.
  const result = ctx.admission.announce({
    kind: existing.kind,
    state: 'done',
    membership: 'settled',
    outcome,
    ...(reported.basis !== undefined ? { outcomeBasis: reported.basis } : {}),
    ...(reported.totalTokens !== undefined ? { totalTokens: reported.totalTokens } : {}),
    ...(reported.lastMessage !== undefined ? { lastMessage: reported.lastMessage } : {}),
    observedAt: Math.max(observedAt, existing.observedAt),
    stoppable: false,
    provenance: STRUCTURED_CHILD_WORK_PROVENANCE,
    parent: ctx.parent,
    provider: ctx.provider,
    aliases: current.aliases,
    fence: existing.invocation,
    lifetime: 'current'
  })
  counted(ctx, handleId, result, 'settled')
}
