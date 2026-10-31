import { AGENT_STATUS_STALE_AFTER_MS } from './agent-status-types'
import type { FleetAgentStatusEvidence } from './orchestration-fleet-agent-status-evidence'
import { projectOrchestrationFleetAttention } from './orchestration-fleet-attention'
import {
  isUnsupervisedSettledDispatch,
  resolveFleetWorkerOutcome
} from './orchestration-fleet-outcome-resolution'
import { readWorkerTerminalHostScope } from './worker-terminal-host-scope'
import type {
  FleetDurableWorker,
  FleetLiveness,
  FleetNextAction,
  FleetResourceProjection,
  OrchestrationFleetWorker
} from './orchestration-fleet-projection'

const FLEET_STATUS_FUTURE_TOLERANCE_MS = 5_000

/** Everything the liveness verdict reads, so every surface can share one projection. */
type FleetLivenessSubject = {
  workerStage?: string | null
  workerState?: string | null
  dispatchStatus?: string | null
  terminationReason?: FleetDurableWorker['terminationReason']
  resource: { releaseState?: string | null; hostScope: string | null } | null
}

/** Durable facts that prove a supervised process ended; the removed-work record reads the same proof. */
export const DURABLE_EXIT_PROOF = {
  workerState: 'stopped',
  workerStage: 'released',
  resourceReleaseState: 'released',
  terminationReasons: ['operator_close', 'signaled', 'exited']
} as const satisfies {
  workerState: string
  workerStage: string
  resourceReleaseState: string
  terminationReasons: readonly NonNullable<FleetDurableWorker['terminationReason']>[]
}

/** Worker states that carry an outcome; anything else is still supposed to be running. */
const SETTLED_WORKER_STATES = new Set(['succeeded', 'failed', 'stopped', 'abandoned'])

/** Any certified termination reason proves exit independently of settlement state. */
function hasCertifiedExit(worker: FleetLivenessSubject): boolean {
  return (
    // unknown means stop without observed exit; null is pre-v29, when the stage alone recorded exit.
    (worker.workerStage === 'process_exited' && worker.terminationReason !== 'unknown') ||
    DURABLE_EXIT_PROOF.terminationReasons.some((reason) => reason === worker.terminationReason)
  )
}

export function projectLiveness(
  worker: FleetLivenessSubject,
  evidence: FleetAgentStatusEvidence | undefined,
  now: number
): FleetLiveness {
  // Federated release proves terminal exit, independently of the worker outcome.
  if (worker.workerStage === DURABLE_EXIT_PROOF.workerStage) {
    return { verdict: 'exited', source: 'execution_host' }
  }
  if (worker.resource?.releaseState === DURABLE_EXIT_PROOF.resourceReleaseState) {
    return { verdict: 'exited', source: 'resource_release' }
  }
  if (worker.workerState === DURABLE_EXIT_PROOF.workerState) {
    return { verdict: 'exited', source: 'worker_stop' }
  }
  // Operator-close settlement also proves exit; it must not fall through to missing_status.
  if (hasCertifiedExit(worker)) {
    return { verdict: 'exited', source: 'execution_host' }
  }
  // Settled unsupervised dispatches have no process to miss, but absence still cannot certify exit.
  if (!evidence && isUnsupervisedSettledDispatch(worker)) {
    return { verdict: 'unverifiable', reason: 'unsupervised_settled' }
  }
  if (!evidence) {
    return { verdict: 'unverifiable', reason: 'missing_status' }
  }
  // Require explicit delivery-clock arms for old hosts; missing producer timestamps cannot masquerade as compatibility.
  const observedAt = evidence.clock.at
  const activity = evidence.activity
  if (activity.restoredUnconfirmed) {
    return { verdict: 'unverifiable', reason: 'restored_unconfirmed', observedAt }
  }
  if (activity.providerSessionOnly) {
    return { verdict: 'unverifiable', reason: 'missing_status', observedAt }
  }
  if (observedAt - now > FLEET_STATUS_FUTURE_TOLERANCE_MS) {
    return { verdict: 'unverifiable', reason: 'future_status', observedAt }
  }
  const remoteHost =
    projectHost(activity.connectionId, worker.resource?.hostScope).kind === 'remote'
  if (remoteHost && !activity.connectionId) {
    return { verdict: 'unverifiable', reason: 'missing_status', observedAt }
  }
  if (now - observedAt > AGENT_STATUS_STALE_AFTER_MS) {
    return { verdict: 'unverifiable', reason: 'stale_status', observedAt }
  }
  return { verdict: 'live', observedAt, source: 'agent_status' }
}

function projectResource(worker: FleetDurableWorker): FleetResourceProjection {
  const resource = worker.resource
  if (!resource) {
    return {
      state: 'absent',
      reason: worker.workerState === 'unsupervised' ? 'unsupervised' : 'not_materialized'
    }
  }
  const state = ['owned', 'transferred', 'user_owned', 'external', 'released'].includes(
    resource.ownershipState
  )
    ? (resource.ownershipState as Exclude<FleetResourceProjection['state'], 'absent'>)
    : 'external'
  return {
    state,
    id: resource.id,
    ownerDispatchId: resource.ownerDispatchId,
    releaseState: resource.releaseState,
    terminalState: worker.terminalState
  }
}

/** Recompute after host verdicts; stale local inspect must not outrank recover for proven remote exit. */
export function projectFleetNextAction(
  worker: FleetDurableWorker,
  liveness: FleetLiveness
): FleetNextAction {
  if (worker.workerStage === 'released') {
    return { kind: 'none', argv: [] }
  }
  if (worker.resource?.autoReleaseAt) {
    return { kind: 'none', argv: [] }
  }
  if (worker.terminalState === 'reclaimable') {
    return {
      kind: 'release',
      argv: ['orchestration', 'worker-release', '--dispatch', worker.dispatchId]
    }
  }
  // Legacy settled dispatches with no resource/worker have nothing to release; inspect would loop.
  if (
    worker.terminalState === 'released' ||
    (worker.dispatchStatus === 'completed' &&
      (!worker.agentTerminalHandle || (isUnsupervisedSettledDispatch(worker) && !worker.resource)))
  ) {
    return { kind: 'none', argv: [] }
  }
  // Settled workers owe only the release of a terminal they still own; worker-show would repeat the settlement.
  if (SETTLED_WORKER_STATES.has(worker.workerState)) {
    return worker.resource?.ownershipState === 'owned' &&
      worker.resource.releaseState !== 'released'
      ? {
          kind: 'release',
          argv: ['orchestration', 'worker-release', '--dispatch', worker.dispatchId]
        }
      : { kind: 'none', argv: [] }
  }
  // Unsettled workers with proven exits need transcript recovery, then stop/abandon; unverifiable absence cannot qualify.
  if (
    liveness.verdict === 'exited' &&
    !SETTLED_WORKER_STATES.has(worker.workerState) &&
    !worker.pendingInput &&
    !worker.pendingApproval
  ) {
    return {
      kind: 'recover',
      argv: ['orchestration', 'worker-read', '--dispatch', worker.dispatchId]
    }
  }
  // Live workers with no pending input owe no action; inspect would repeat this projection.
  if (
    liveness.verdict === 'live' &&
    worker.workerState === 'ready' &&
    !worker.pendingInput &&
    !worker.pendingApproval
  ) {
    return { kind: 'none', argv: [] }
  }
  // worker-show repeats this projection; absence alone cannot earn another command.
  if (liveness.verdict === 'unverifiable' && !worker.pendingInput && !worker.pendingApproval) {
    return { kind: 'none', argv: [] }
  }
  return {
    kind: 'inspect',
    argv: ['orchestration', 'worker-show', '--dispatch', worker.dispatchId]
  }
}

function projectHost(
  connectionId: string | null,
  hostScope: string | null | undefined
): OrchestrationFleetWorker['host'] {
  if (connectionId) {
    return { kind: 'remote', id: connectionId }
  }
  const read = readWorkerTerminalHostScope(hostScope)
  switch (read.kind) {
    // Absent host scope is legacy local/folder authority; resource materialization alone cannot imply remote execution.
    case 'absent':
      return { kind: 'local', id: 'local' }
    case 'local':
      return { kind: 'local', id: read.id }
    case 'remote':
      return { kind: 'remote', id: read.id }
    case 'unreadable':
      return { kind: 'remote', id: 'unknown' }
  }
}

export function projectOrchestrationFleetWorker(
  worker: FleetDurableWorker,
  evidence: FleetAgentStatusEvidence | undefined,
  now: number
): OrchestrationFleetWorker {
  const liveness = projectLiveness(worker, evidence, now)
  const fresh = liveness.verdict === 'live'
  const activity = evidence?.activity
  const workspaceId =
    activity?.worktreeId ?? worker.worktreeId ?? worker.resource?.worktreeId ?? null
  const outcome = resolveFleetWorkerOutcome({
    attemptOutcome: worker.outcome,
    workerState: worker.workerState,
    dispatchStatus: worker.dispatchStatus
  })
  return {
    id: worker.dispatchId,
    dispatchId: worker.dispatchId,
    taskId: worker.taskId,
    runId: worker.runId,
    role: 'worker',
    parent: worker.parentTaskId ? { taskId: worker.parentTaskId } : null,
    provider: activity?.agentType ? { id: activity.agentType, model: activity.model } : null,
    host: projectHost(activity?.connectionId ?? null, worker.resource?.hostScope),
    workspace: workspaceId ? { id: workspaceId, kind: 'folder_or_worktree' } : null,
    stage: {
      worker: worker.workerState,
      dispatch: worker.dispatchStatus,
      detail: worker.workerStage,
      activity: fresh && activity ? activity.state : 'unknown'
    },
    outcome,
    liveness,
    evidence: {
      durable: true,
      liveStatus: !evidence
        ? 'unavailable'
        : evidence.activity.restoredUnconfirmed
          ? 'redacted_restore'
          : fresh
            ? 'fresh'
            : 'stale',
      lastObservedAt: evidence ? evidence.clock.at : null
    },
    resource: projectResource(worker),
    ...(worker.resource?.autoReleaseAt ? { autoReleaseAt: worker.resource.autoReleaseAt } : {}),
    nextAction: projectFleetNextAction(worker, liveness),
    attention: projectOrchestrationFleetAttention({
      isRoot: worker.parentTaskId === null,
      outcome,
      pendingInput: worker.pendingInput,
      pendingApproval: worker.pendingApproval,
      interrupted:
        worker.workerState === 'abandoned' ||
        worker.terminationReason === 'operator_close' ||
        worker.terminationReason === 'signaled',
      liveness
    })
  }
}
