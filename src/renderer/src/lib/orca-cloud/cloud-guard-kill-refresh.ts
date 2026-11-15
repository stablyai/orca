// MEMGUARD: the guard-kill banner should follow the kill closely, not the next minute's poll. The
// VM rewrites the guard's state at the kill, and main's OOM tracker observes every status read
// (hosted-workspace-service getStatus), so all it takes is a read soon after: re-read the active
// cloud workspace when the window regains focus or the user types, throttled.

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
