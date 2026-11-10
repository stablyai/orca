import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import {
  armRunActionRelaunch,
  disarmRunActionRelaunch,
  relaunchInterruptedRunActions
} from '@/lib/run-actions/run-action-controller'

/**
 * Sleep does not keep processes, so a woken VM has fresh shells. Remember the running run actions
 * when the wake starts (the host rebuilds its tab list meanwhile) and start them again once ready.
 */
export function syncRunActionsWithWake(
  event: Pick<CloudWakeProgressEvent, 'workspaceId' | 'phase'>
): void {
  if (event.phase === 'waking' || event.phase === 'connecting') {
    armRunActionRelaunch(event.workspaceId)
  } else if (event.phase === 'ready') {
    void relaunchInterruptedRunActions(event.workspaceId)
  } else {
    disarmRunActionRelaunch(event.workspaceId)
  }
}
