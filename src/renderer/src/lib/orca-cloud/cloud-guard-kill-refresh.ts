// MEMGUARD: the guard-kill banner should follow the kill closely, not the next minute's poll.
// Two pieces: (1) any status read that shows a newer guard kill raises the notice right away
// (main's minute-long OOM poll announces the same count later, which changes nothing); (2) the
// active cloud workspace's status is re-read when the window regains focus or the user types,
// throttled, so the read that carries the kill happens when someone is there to see it.
import type {
  CloudOomEvent,
  CloudWorkspaceStatus
} from '../../../../shared/hosted-sandbox/cloud-workspace-api'

const seenKillAt = new Map<string, number>()

/** The notice for a guard kill this status shows and no earlier read did; null otherwise. */
export function guardKillFromStatus(
  workspaceId: string,
  status: CloudWorkspaceStatus,
  now = Date.now()
): CloudOomEvent | null {
  const memory = status.memory
  if (!memory || memory.guardKills === 0 || memory.lastGuardKillAt === null) {
    return null
  }
  if (memory.lastGuardKillAt <= (seenKillAt.get(workspaceId) ?? 0)) {
    return null
  }
  seenKillAt.set(workspaceId, memory.lastGuardKillAt)
  return {
    workspaceId,
    // The count main's tracker uses (kernel + guard), so a dismissal holds for both sources.
    oomKills: (status.metrics?.oomKills ?? 0) + memory.guardKills,
    victim: memory.lastGuardVictim,
    stoppedBy: 'guard',
    at: now
  }
}

/** Test seam. */
export function resetGuardKillSeen(): void {
  seenKillAt.clear()
}

export const ACTIVITY_REFRESH_MS = 15_000

/**
 * Re-reads the active cloud workspace's status on window focus and on typing, at most once per
 * ACTIVITY_REFRESH_MS per workspace, and only while it runs (a sleeping VM is never probed).
 */
export function installCloudActivityRefresh(deps: {
  activeWorkspaceId: () => string | null
  isRunningCloud: (workspaceId: string) => boolean
  refresh: (workspaceId: string) => void
  target?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  now?: () => number
}): () => void {
  const target = deps.target ?? window
  const now = deps.now ?? Date.now
  const lastAt = new Map<string, number>()
  const onActivity = (): void => {
    const id = deps.activeWorkspaceId()
    if (!id || !deps.isRunningCloud(id)) {
      return
    }
    const at = now()
    if (at - (lastAt.get(id) ?? -Infinity) < ACTIVITY_REFRESH_MS) {
      return
    }
    lastAt.set(id, at)
    deps.refresh(id)
  }
  target.addEventListener('focus', onActivity)
  target.addEventListener('keydown', onActivity, { capture: true, passive: true })
  return () => {
    target.removeEventListener('focus', onActivity)
    target.removeEventListener('keydown', onActivity, { capture: true })
  }
}
