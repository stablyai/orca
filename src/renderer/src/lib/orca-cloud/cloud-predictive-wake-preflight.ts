// The server half of predictive wake's guard: read just before waking, so sleeps chosen from the
// CLI, the phone or another window count, and a guess never takes a seat's last running slot.
import type { HostedWorkspaceStatus } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import type { SandboxLimit } from '@/components/worktree-creation/vm-build-failure-copy'
import { SLEEP_COOLDOWN_MS } from './cloud-predictive-wake'

export type PredictiveWakeServerVerdict =
  | 'ok'
  | 'not-sleeping'
  | 'recently-slept'
  | 'seat-near-cap'
  | 'team-near-cap'

/**
 * `limit` is billing's running caps (per member seat, per team), null when unknown. Older control
 * planes omit the hints; then only the local checks apply and a refusal stays silent.
 */
export function predictiveWakeServerVerdict(
  status: HostedWorkspaceStatus | null,
  limit: SandboxLimit | null
): PredictiveWakeServerVerdict {
  if (!status || status.state !== 'sleeping') {
    return 'not-sleeping'
  }
  // Both times are the server's clock, so a skewed desktop clock can't stretch or skip the hold.
  const slept = status.lastUserSleepAt
  if (slept != null && status.checkedAt - slept < SLEEP_COOLDOWN_MS) {
    return 'recently-slept'
  }
  const running = status.running
  if (running && limit) {
    // At or one below the cap: the last slot is kept for a workspace someone actually opens.
    if (running.owner >= limit.perSeat - 1) {
      return 'seat-near-cap'
    }
    if (running.account >= limit.team - 1) {
      return 'team-near-cap'
    }
  }
  return 'ok'
}
