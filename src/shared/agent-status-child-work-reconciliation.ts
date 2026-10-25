// Patch only this producer's child records. Own endings settle; session loss settles unknown; reportless work is removed. Keep settled children until the next accepted user send or parent removal, without inferring outcomes.

import type { AgentChildWorkAdmission } from './agent-status-child-work-admission'
import { agentChildWorkFencesEqual } from './agent-status-child-work'
import { settledOwnersOfLiveWork } from './agent-status-child-work-liveness'
import type {
  AgentChildWorkEndedEvidence,
  AgentChildWorkEvidence,
  AgentChildWorkOperationEvidence,
  AgentChildWorkRemovedEvidence,
  AgentChildWorkStopAcknowledgedEvidence
} from './agent-status-child-work-evidence'
import {
  applyAgentChildWorkLive,
  settleAgentChildWork,
  agentChildWorkRunVerdict,
  type AgentChildWorkEvidenceContext,
  type AgentChildWorkReconcileOutcome
} from './agent-status-child-work-evidence-admission'
import {
  currentAgentChildWorkAliases,
  ownedStructuredChildWork,
  resolveAgentChildWorkHandle,
  type AgentChildWorkEvidenceScope
} from './agent-status-child-work-evidence-resolution'

export type { AgentChildWorkReconcileOutcome } from './agent-status-child-work-evidence-admission'

export type AgentChildWorkReconcileInput = AgentChildWorkEvidenceScope & {
  admission: AgentChildWorkAdmission
  evidence: readonly AgentChildWorkEvidence[]
}

type ReconcileContext = AgentChildWorkEvidenceContext

function applyEnded(ctx: ReconcileContext, edge: AgentChildWorkEndedEvidence): void {
  const resolution = resolveAgentChildWorkHandle(ctx, [edge.handle.idKind], edge.handle.id)
  const existing = resolution?.child
  if (resolution?.ambiguous) {
    ctx.outcome.rejected.push({ handleId: edge.handle.id, reason: 'ambiguous' })
    return
  }
  if (!existing) {
    return
  }
  // Ignore known ended runs; accept unknown run IDs so a missed spawn cannot lose an ending.
  if (agentChildWorkRunVerdict(ctx, existing, edge.handle.runId) === 'previous') {
    return
  }
  // Admission preserves definite outcomes against unknown evidence and refuses contradictory definite endings as stale-invocation.
  settleAgentChildWork(ctx, existing, edge.outcome, edge.observedAt, {
    ...(edge.lastMessage !== undefined ? { lastMessage: edge.lastMessage } : {}),
    ...(edge.totalTokens !== undefined ? { totalTokens: edge.totalTokens } : {})
  })
}

/** Settle only the Stop's captured run, preserving its own earlier ending or using the provider reply's verdict. */
function applyStopAcknowledged(
  ctx: ReconcileContext,
  edge: AgentChildWorkStopAcknowledgedEvidence
): void {
  const record = ownedStructuredChildWork(ctx).find(
    (candidate) => candidate.childWorkId === edge.childWorkId
  )
  if (!record || !agentChildWorkFencesEqual(record.invocation, edge.invocation)) {
    return
  }
  if (edge.outcome !== undefined) {
    settleAgentChildWork(ctx, record, edge.outcome, edge.observedAt)
  } else if (record.membership === 'live') {
    settleAgentChildWork(ctx, record, 'cancelled', edge.observedAt, { basis: 'stop-acknowledged' })
  }
}

/** A live child's current operation, and nothing else about it. */
function applyOperation(ctx: ReconcileContext, edge: AgentChildWorkOperationEvidence): void {
  const resolution = resolveAgentChildWorkHandle(
    ctx,
    ['task_id', 'thread_id', 'tool_use_id'],
    edge.childId
  )
  const record = resolution?.ambiguous ? null : resolution?.child
  if (!record || record.membership !== 'live' || record.state === 'done' || !record.residency) {
    return
  }
  const { stable, runId } = currentAgentChildWorkAliases(ctx, record)
  if (!stable) {
    return
  }
  applyAgentChildWorkLive(
    ctx,
    {
      handle: { ...stable, ...(runId !== undefined ? { runId } : {}) },
      kind: record.kind,
      residency: record.residency,
      state: record.state,
      stoppable: record.stoppable,
      operation: edge.operation
    },
    edge.observedAt,
    false
  )
}

/** The session is gone: whatever it still ran can no longer report its own ending. */
function settleLive(ctx: ReconcileContext, observedAt: number): void {
  for (const record of ownedStructuredChildWork(ctx)) {
    if (record.membership === 'live') {
      settleAgentChildWork(ctx, record, 'unknown', observedAt)
    }
  }
}

function removeChildren(ctx: ReconcileContext, childWorkIds: string[]): void {
  if (childWorkIds.length > 0 && ctx.store.applyMutation({ removeChildren: childWorkIds })) {
    ctx.outcome.removed += childWorkIds.length
  }
}

/** The work is gone and has no ending to keep: its record, and the handles it answered to, go. */
function applyRemoved(ctx: ReconcileContext, edge: AgentChildWorkRemovedEvidence): void {
  const resolution = resolveAgentChildWorkHandle(ctx, [edge.handle.idKind], edge.handle.id)
  if (resolution?.ambiguous) {
    ctx.outcome.rejected.push({ handleId: edge.handle.id, reason: 'ambiguous' })
    return
  }
  const existing = resolution?.child
  if (!existing || agentChildWorkRunVerdict(ctx, existing, edge.handle.runId) === 'previous') {
    return
  }
  removeChildren(ctx, [existing.childWorkId])
}

/** Retire settled children except owners of live descendants at any depth, matching surface retention. */
function removableSettled(ctx: ReconcileContext): string[] {
  const owned = ownedStructuredChildWork(ctx)
  const owners = settledOwnersOfLiveWork(
    owned.map((record) => ({
      id: record.childWorkId,
      membership: record.membership,
      ...(record.parentChildWorkId ? { ownerId: record.parentChildWorkId } : {})
    }))
  )
  return owned
    .filter((record) => record.membership === 'settled' && !owners.has(record.childWorkId))
    .map((record) => record.childWorkId)
}

/** Require the stored parent before admitting evidence; producers cannot invent parent identities. */
export function reconcileAgentChildWorkEvidence(
  input: AgentChildWorkReconcileInput
): AgentChildWorkReconcileOutcome {
  const ctx: ReconcileContext = {
    ...input,
    outcome: { admitted: 0, settled: 0, removed: 0, rejected: [] }
  }
  for (const edge of input.evidence) {
    if (!Number.isFinite(edge.observedAt) || edge.observedAt < 0) {
      continue
    }
    if (edge.type === 'live') {
      applyAgentChildWorkLive(ctx, edge.child, edge.observedAt, edge.restart === true)
    } else if (edge.type === 'operation') {
      applyOperation(ctx, edge)
    } else if (edge.type === 'ended') {
      applyEnded(ctx, edge)
    } else if (edge.type === 'removed') {
      applyRemoved(ctx, edge)
    } else if (edge.type === 'stop-acknowledged') {
      applyStopAcknowledged(ctx, edge)
    } else if (edge.type === 'turn-started') {
      removeChildren(ctx, removableSettled(ctx))
    } else {
      settleLive(ctx, edge.observedAt)
    }
  }
  return ctx.outcome
}
