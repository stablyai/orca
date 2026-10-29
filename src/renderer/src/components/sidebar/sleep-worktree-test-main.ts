import type {
  WorkspaceSleepOutcome,
  WorkspaceSleepRequest,
  WorkspaceSleepTarget
} from '../../../../shared/workspace-sleep'
import { followWorkspaceSleep } from './workspace-sleep-follower'

/** Main's sleep as the window sees it: a started notice, the host's answer, then ended. */
export function fakeMainSleep(
  answer: (target: WorkspaceSleepTarget) => Partial<WorkspaceSleepOutcome> = () => ({})
) {
  const requests: WorkspaceSleepRequest[] = []
  const sleep = async (request: WorkspaceSleepRequest): Promise<WorkspaceSleepOutcome[]> => {
    requests.push(request)
    const outcomes: WorkspaceSleepOutcome[] = []
    for (const target of request.targets) {
      followWorkspaceSleep({ worktreeId: target.worktreeId, phase: 'started' })
      const outcome = {
        worktreeId: target.worktreeId,
        chatFailed: false,
        receipts: [],
        ...answer(target)
      }
      followWorkspaceSleep({
        worktreeId: target.worktreeId,
        phase: 'ended',
        slept: outcome.failure === undefined,
        stoppedPtyIds: outcome.failure === undefined ? null : [],
        records: null
      })
      outcomes.push(outcome)
    }
    // The window's own teardown follows the notices; let it settle before the reply lands.
    await new Promise((resolve) => setTimeout(resolve, 0))
    return outcomes
  }
  return { requests, sleep }
}
