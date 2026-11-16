import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import { liveAtShutdown } from '../../../../../shared/workspace-layout/terminal-topology/unattached-terminal-row-sweep'
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
  // Resume records are no sleep signal here: running agents keep live/quit ones too.
  const live = liveAtShutdown(session)
  const awake = candidates.filter(
    (worktree) => (tabsByWorktree[worktree.id]?.length ?? 0) === 0 || live(worktree.id)
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
