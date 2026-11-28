import { AGENT_STATUS_STALE_AFTER_MS } from '../../agent-status/contracts/agent-status-freshness'
import type { FleetAgentStatusEvidence } from './orchestration-fleet-agent-status-evidence'
import { projectOrchestrationFleetAttention } from './orchestration-fleet-attention'
import {
  isUnsupervisedSettledDispatch,
  resolveFleetWorkerOutcome
} from './orchestration-fleet-outcome-resolution'
import { readWorkerTerminalHostScope } from '../workers/worker-terminal-host-scope'
import { projectFleetNextAction, SETTLED_WORKER_STATES } from './orchestration-fleet-next-action'
import type {
  FleetDurableWorker,
  FleetLiveness,
  FleetResourceProjection,
  FleetSessionObservation,
  OrchestrationFleetWorker
} from './orchestration-fleet-projection'

export { projectFleetNextAction, SETTLED_WORKER_STATES }

const FLEET_STATUS_FUTURE_TOLERANCE_MS = 5_000

/** Everything the liveness verdict reads, so every surface can share one projection. */
type FleetLivenessSubject = {
  workerStage?: string | null
  workerState?: string | null
  dispatchStatus?: string | null
  terminationReason?: FleetDurableWorker['terminationReason']
  resource: { releaseState?: string | null; hostScope: string | null } | null
  handedOn?: { resource: { releaseState: string } | null } | null
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
  now: number,
  session?: FleetSessionObservation
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
  // A settled Dispatch's handed-on terminal is its follow-up's; only that shared row's release proves exit.
  if (worker.handedOn && worker.workerState && SETTLED_WORKER_STATES.has(worker.workerState)) {
    return worker.handedOn.resource?.releaseState === DURABLE_EXIT_PROOF.resourceReleaseState
      ? { verdict: 'exited', source: 'resource_release' }
      : { verdict: 'unverifiable', reason: 'handed_on' }
  }
  // Chat-mode workers have no hook stream; the structured host's own verdict is their liveness.
  if (session) {
    switch (session.status) {
      case 'live':
        return { verdict: 'live', observedAt: now, source: 'execution_host' }
      case 'exited':
        return { verdict: 'exited', source: 'execution_host' }
      case 'unverifiable':
        return { verdict: 'unverifiable', reason: 'host_unavailable', detail: session.detail }
    }
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

/** A live chat-mode session's own status row, whatever its age; age dates activity, not liveness. */
export function sessionActivityEvidence(
  session: FleetSessionObservation
): FleetAgentStatusEvidence | undefined {
  const activity = session.status === 'live' ? session.activity : undefined
  return activity && !activity.activity.restoredUnconfirmed ? activity : undefined
}

function projectResource(worker: FleetDurableWorker): FleetResourceProjection {
  const resource = worker.resource
  const handedOn = worker.handedOn
  if (!resource && handedOn?.resource) {
    return {
      state: 'transferred',
      id: handedOn.resource.id,
      ownerDispatchId: handedOn.resource.ownerDispatchId,
      releaseState: handedOn.resource.releaseState,
      terminalState: worker.terminalState
    }
  }
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
  hookEvidence: FleetAgentStatusEvidence | undefined,
  now: number,
  session?: FleetSessionObservation
): OrchestrationFleetWorker {
  const liveness = projectLiveness(worker, hookEvidence, now, session)
  // A live session's own status row dates its last activity; its age never makes the worker stale.
  const evidence = session ? sessionActivityEvidence(session) : hookEvidence
  const fresh = liveness.verdict === 'live' && Boolean(evidence)
  const activity = evidence?.activity
  const workspaceId =
    activity?.worktreeId ?? worker.worktreeId ?? worker.resource?.worktreeId ?? null
  const outcome = resolveFleetWorkerOutcome({
    attemptOutcome: worker.outcome,
    workerState: worker.workerState,
    dispatchStatus: worker.dispatchStatus
  })
  const canResume =
    session?.status === 'exited' &&
    session.canResume === true &&
    worker.workerState === 'ready' &&
    worker.dispatchStatus === 'dispatched' &&
    worker.terminalState !== 'released' &&
    worker.resource?.releaseState !== 'released' &&
    !hasCertifiedExit(worker)
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
      activity: fresh && activity ? activity.state : 'unknown',
      // A stale row still names the wait it last saw; an exit ends it.
      ...(activity?.backgroundWait && liveness.verdict !== 'exited'
        ? { backgroundWait: activity.backgroundWait }
        : {})
    },
    outcome,
    liveness,
    evidence: {
      durable: true,
      liveStatus: session
        ? liveness.verdict === 'live'
          ? 'fresh'
          : 'unavailable'
        : !evidence
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
    nextAction: projectFleetNextAction(worker, liveness, canResume),
    attention: projectOrchestrationFleetAttention({
      isRoot: worker.parentTaskId === null,
      outcome,
      pendingInput: worker.pendingInput,
      pendingApproval: worker.pendingApproval,
      interrupted:
        canResume ||
        worker.workerState === 'abandoned' ||
        worker.terminationReason === 'operator_close' ||
        worker.terminationReason === 'signaled',
      liveness
    })
  }
}
