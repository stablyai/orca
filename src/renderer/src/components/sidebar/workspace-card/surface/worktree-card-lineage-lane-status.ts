import type { WorktreeStatus } from '../../../../../../shared/worktree-status-rollup'
import type { SlotException } from '../../worktree-card-slot-signal'

// Only the states loud enough to take over a collapsed parent's lane; unread stays on the bold title.
const LANE_URGENCY: Partial<Record<WorktreeStatus, number>> = {
  permission: 0,
  failed: 1,
  working: 2,
  monitoring: 3,
  unconfirmed: 4,
  interrupted: 5
}

/** The lane status collapsed descendants would claim: needs you, then failed, then working. */
export function lineageLaneStatus(exceptions: readonly SlotException[]): WorktreeStatus | null {
  let best: WorktreeStatus | null = null
  for (const exception of exceptions) {
    const status: WorktreeStatus | null =
      exception.kind === 'needs'
        ? 'permission'
        : exception.kind === 'failed'
          ? 'failed'
          : exception.kind === 'working'
            ? exception.monitoring
              ? 'monitoring'
              : 'working'
            : null
    if (status && (best === null || LANE_URGENCY[status]! < LANE_URGENCY[best]!)) {
      best = status
    }
  }
  return best
}

/** The parent's own status, unless a collapsed descendant's is more urgent. */
export function laneStatusWithLineage(
  own: WorktreeStatus,
  lineage: WorktreeStatus | null | undefined
): WorktreeStatus {
  if (!lineage) {
    return own
  }
  const ownUrgency = LANE_URGENCY[own] ?? Number.POSITIVE_INFINITY
  return LANE_URGENCY[lineage]! < ownUrgency ? lineage : own
}
