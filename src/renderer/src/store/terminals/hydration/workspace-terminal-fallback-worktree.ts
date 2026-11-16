import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import { getWorktreeVisitTimestamp } from '@/lib/workspace/activation/worktree-visit-recency'

/** Pick the active repo's main worktree, else its most recently visited one, skipping any asleep at quit. */
export function pickFallbackActiveWorktree({
  candidates,
  session,
  tabsByWorktree
}: {
  candidates: readonly Worktree[]
  session: WorkspaceSessionState
  tabsByWorktree: Record<string, TerminalTab[]>
}): Worktree | null {
  // Selecting a slept workspace wakes it and resumes its agents; a startup fallback is not a click.
  // Only the shutdown list tells sleep apart: running agents keep resume records, and slept tabs keep ptyIds.
  const listed = session.activeWorktreeIdsOnShutdown
  const live = listed ? new Set(listed) : null
  const awake = candidates.filter(
    (worktree) => !live || (tabsByWorktree[worktree.id]?.length ?? 0) === 0 || live.has(worktree.id)
  )
  const lastVisited = session.lastVisitedAtByWorktreeId
  return (
    awake.find((worktree) => worktree.isMainWorktree) ??
    awake.reduce<Worktree | null>(
      (best, worktree) =>
        !best ||
        (getWorktreeVisitTimestamp(lastVisited, worktree) ?? 0) >
          (getWorktreeVisitTimestamp(lastVisited, best) ?? 0)
          ? worktree
          : best,
      null
    )
  )
}
