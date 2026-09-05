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

/** Worker states that carry an outcome; anything else is still supposed to be running. */
const SETTLED_WORKER_STATES = new Set(['succeeded', 'failed', 'stopped', 'abandoned'])

/** `termination_reason` is only ever written from an observed process end, so anything but
 *  `unknown` is a death certificate — regardless of which state the worker settled into. */
function hasCertifiedExit(worker: FleetLivenessSubject): boolean {
  return (
    // `process_exited` is written from the same cause as the reason beside it, and
    // `unknown` there means a stop was issued and no exit was ever observed. A null
    // reason is a pre-v29 row whose stage write was the only exit record.
    (worker.workerStage === 'process_exited' && worker.terminationReason !== 'unknown') ||
    worker.terminationReason === 'operator_close' ||
    worker.terminationReason === 'signaled' ||
    worker.terminationReason === 'exited'
  )
}

export function projectLiveness(
  worker: FleetLivenessSubject,
  evidence: FleetAgentStatusEvidence | undefined,
  now: number
): FleetLiveness {
  // A federated release is an execution-host confirmation that the terminal
  // is gone. The worker outcome remains independent of this cleanup fact.
  if (worker.workerStage === 'released') {
    return { verdict: 'exited', source: 'execution_host' }
  }
  if (worker.resource?.releaseState === 'released') {
    return { verdict: 'exited', source: 'resource_release' }
  }
  if (worker.workerState === 'stopped') {
    return { verdict: 'exited', source: 'worker_stop' }
  }
  // An operator close settles the worker as `failed`, which used to fall through to
  // `missing_status` and report a proven-dead worker as absence in the same receipt.
  if (hasCertifiedExit(worker)) {
    return { verdict: 'exited', source: 'execution_host' }
  }
  // A settled Dispatch with no worker row never had a supervised process, so there is no
  // absence to report. Not `exited`: nothing ever certified an exit, and absence is not proof.
  if (!evidence && isUnsupervisedSettledDispatch(worker)) {
    return { verdict: 'unverifiable', reason: 'unsupervised_settled' }
  }
  if (!evidence) {
    return { verdict: 'unverifiable', reason: 'missing_status' }
  }
  // The clock is an arm, not a fallback: a host with no observation clock reports `delivery`
  // explicitly, so a producer that simply forgot to stamp one cannot look like an old host.
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

/** Exported so a later host verdict can re-derive it; `inspect` under a stale local
 *  verdict outranked the `recover` a proven remote exit owes. */
export function projectFleetNextAction(
  worker: FleetDurableWorker,
  liveness: FleetLiveness
): FleetNextAction {
  if (worker.workerStage === 'released') {
    return { kind: 'none', argv: [] }
  }
  if (worker.terminalState === 'reclaimable') {
    return {
      kind: 'release',
      argv: ['orchestration', 'worker-release', '--dispatch', worker.dispatchId]
    }
  }
  // A completed Dispatch with no worker row and no resource kept a stale pre-v3 terminal handle:
  // there is no worker to show and nothing to release, so `inspect` was a self-loop on this row.
  if (
    worker.terminalState === 'released' ||
    (worker.dispatchStatus === 'completed' &&
      (!worker.agentTerminalHandle || (isUnsupervisedSettledDispatch(worker) && !worker.resource)))
  ) {
    return { kind: 'none', argv: [] }
  }
  // A settled worker still owning its terminal owes the release decision. Pointing it at
  // worker-show was a self-loop: the command that reported the settlement.
  if (SETTLED_WORKER_STATES.has(worker.workerState) && worker.resource) {
    return worker.resource.ownershipState === 'owned' && worker.resource.releaseState !== 'released'
      ? {
          kind: 'release',
          argv: ['orchestration', 'worker-release', '--dispatch', worker.dispatchId]
        }
      : { kind: 'none', argv: [] }
  }
  // A proven exit under a worker that never settled is a stall; worker-show would
  // only restate it. Read the transcript, then stop or abandon. `unverifiable` is
  // absence and must never land here.
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
  // A running worker with a live verdict and nothing pending owes the coordinator
  // nothing; `inspect` is the unknown-state bucket, and worker-show publishes this
  // same projection, so pointing there was a self-loop on its own receipt.
  if (
    liveness.verdict === 'live' &&
    worker.workerState === 'ready' &&
    !worker.pendingInput &&
    !worker.pendingApproval
  ) {
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
    // A missing host scope is the legacy/default representation for local and
    // folder-workspace authority; do not infer a remote host from resource
    // materialization alone.
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
