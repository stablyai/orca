// A chat's worker drawn by the Crew panel's status rules (an open ask is its coordinator's), for the tray, Activity and bot feed.
import { translate } from '@/i18n/i18n'
import { getWorktreeStatusLabel } from '@/lib/workspace/activity/worktree-status'
import type { WorktreeStatus } from '../../../shared/worktree/row-display/worktree-status-rollup'
import {
  crewPartyStatus,
  crewStatusGroup,
  type CrewStatusGroup
} from '@/components/orchestration-crew/crew-party-status'
import {
  sessionWorkerAgentState,
  sessionWorkerAsksCoordinator,
  sessionWorkerIsRunning,
  type OrchestrationSessionWorker
} from '../../../shared/orchestration-session-workers'

export type SessionWorkerLook = {
  status: WorktreeStatus
  group: CrewStatusGroup
  /** Resting on its coordinator's answer: an idle worker with a reason, never one needing you. */
  asksCoordinator: boolean
}

export function sessionWorkerLook(
  worker: Pick<OrchestrationSessionWorker, 'state' | 'activity' | 'pendingQuestion'>
): SessionWorkerLook {
  const open = sessionWorkerIsRunning(worker)
  const status = crewPartyStatus({
    // What the host verdict knows that an agent state cannot: lost contact, or an exit before it reported.
    dot:
      worker.state === 'unverifiable'
        ? 'unverifiable'
        : worker.state === 'stopped'
          ? 'interrupted'
          : undefined,
    status: open ? sessionWorkerAgentState(worker) : 'done',
    taskFailed: worker.state === 'failed'
  })
  return {
    status,
    group: crewStatusGroup(status),
    asksCoordinator: sessionWorkerAsksCoordinator(worker)
  }
}

/** Words for a worker that is not mid-turn, in place of its ticking time. */
export function sessionWorkerRestingLabel(look: SessionWorkerLook, coordinator: string): string {
  if (look.asksCoordinator) {
    return translate('bots.activity.askedCoordinator', 'Asked {{name}} a question', {
      name: coordinator
    })
  }
  switch (look.group) {
    case 'needsYou':
      return translate('bots.activity.needsYou', 'Needs you')
    case 'idle':
      return translate('bots.activity.idle', 'Idle')
    case 'failed':
    case 'working':
      return getWorktreeStatusLabel(look.status)
  }
}
