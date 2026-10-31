import type { AppState } from '../../../types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getOpenFileExecutionHostId } from '@/lib/unified-tab-host-ownership'

/** Histories belong to a gesture context but die with their genuine resource owner. */
export function purgeClosedWorkspaceSources(
  state: AppState,
  removed: (workspaceId: string, hostId: ExecutionHostId | undefined) => boolean
): Partial<AppState> {
  const prune = <T>(
    map: Record<string, T[]>,
    source: (entry: T, context: string) => { workspaceId: string; hostId?: ExecutionHostId }
  ): Record<string, T[]> => {
    let next: Record<string, T[]> | undefined
    for (const [context, entries] of Object.entries(map)) {
      const kept = entries.filter((entry) => {
        const owner = source(entry, context)
        return !removed(owner.workspaceId, owner.hostId)
      })
      if (kept.length !== entries.length) {
        ;(next ??= { ...map })[context] = kept
      }
    }
    return next ?? map
  }
  return {
    recentlyClosedEditorTabsByWorktree: prune(
      state.recentlyClosedEditorTabsByWorktree,
      (entry) => ({ workspaceId: entry.worktreeId, hostId: getOpenFileExecutionHostId(entry) })
    ),
    recentlyClosedBrowserTabsByWorktree: prune(
      state.recentlyClosedBrowserTabsByWorktree,
      (entry) => ({ workspaceId: entry.workspace.worktreeId, hostId: entry.sourceHostId })
    ),
    recentlyClosedTerminalTabsByWorktree: prune(
      state.recentlyClosedTerminalTabsByWorktree,
      (entry, context) => ({
        workspaceId: entry.sourceWorkspaceId ?? context,
        hostId: entry.sourceHostId
      })
    )
  }
}
