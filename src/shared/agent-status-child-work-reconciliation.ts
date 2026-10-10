// Fold one structured session's child-work evidence into the host's records.
//
// The store holds the only current record per child; evidence patches it. A child settles on its
// own ending, or `unknown` when its session ends while it is still live; work with nothing to
// report once it stops is removed instead. Settled children stay until the user's next turn (the
// next send the provider accepts) or the host drops the parent's row. It owns only the records its
// own producer admitted, and never claims an outcome the evidence did not report.

import type { AgentChildWorkAdmission } from './agent-status-child-work-admission'
import { settledOwnersOfLiveWork } from './agent-status-child-work-liveness'
import type {
  AgentChildWorkEndedEvidence,
  AgentChildWorkEvidence,
  AgentChildWorkOperationEvidence,
  AgentChildWorkRemovedEvidence
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
  // A run that is already over cannot end the current one; a run id the record never saw can,
  // so an ending is never lost to a spawn call the host missed.
  if (agentChildWorkRunVerdict(ctx, existing, edge.handle.runId) === 'previous') {
    return
  }
  // Admission owns what a second ending may change: an `unknown` one keeps a definite outcome and
  // lands its evidence; a conflicting definite one is refused as `stale-invocation`.
  settleAgentChildWork(ctx, existing, edge.outcome, edge.observedAt, {
    ...(edge.lastMessage !== undefined ? { lastMessage: edge.lastMessage } : {}),
    ...(edge.totalTokens !== undefined ? { totalTokens: edge.totalTokens } : {}),
    ...(edge.basis !== undefined ? { basis: edge.basis } : {})
  })
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

/** Settled children, less any that still owns live work at any depth: those stay so that work
 *  keeps every owner, by the same rule the surfaces list them by. */
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

/** Apply one batch of evidence. The parent must already be held: the store refuses a child whose
 *  parent it does not hold, which keeps a producer from inventing a parent of its own. */
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
    } else if (edge.type === 'turn-started') {
      removeChildren(ctx, removableSettled(ctx))
    } else {
      settleLive(ctx, edge.observedAt)
    }
  }
  return ctx.outcome
}
