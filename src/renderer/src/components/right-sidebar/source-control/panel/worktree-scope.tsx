import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import type { Repo } from '../../../../../../shared/repo-types'
import type { AttachedWorktreeOwner } from '../../folder-workspace-attached-worktrees'

export type SourceControlScope = AttachedWorktreeOwner & {
  repo: Repo
  placementWorkspaceId: string
}
const WorktreeScope = createContext<SourceControlScope | null>(null)
const mountedScopeCounts = new Map<string, number>()

/** Whether a folder section for this worktree is on screen, so its row actions can still apply. */
export function isSourceControlScopeMounted(worktreeId: string | null): boolean {
  return worktreeId !== null && mountedScopeCounts.has(worktreeId)
}
export function SourceControlScopeProvider({
  owner,
  children
}: {
  owner: SourceControlScope
  children?: ReactNode
}) {
  const { worktreeId } = owner
  useEffect(() => {
    mountedScopeCounts.set(worktreeId, (mountedScopeCounts.get(worktreeId) ?? 0) + 1)
    return () => {
      const remaining = (mountedScopeCounts.get(worktreeId) ?? 1) - 1
      if (remaining > 0) {
        mountedScopeCounts.set(worktreeId, remaining)
      } else {
        mountedScopeCounts.delete(worktreeId)
      }
    }
  }, [worktreeId])
  return <WorktreeScope.Provider value={owner}>{children}</WorktreeScope.Provider>
}
export function useSourceControlScope(): SourceControlScope | null {
  return useContext(WorktreeScope)
}

/** A folder section's repo connection for its own worktree; otherwise the selected copy's. */
export function sourceControlConnectionId(
  scope: SourceControlScope | null,
  worktreeId: string | null
): string | undefined {
  return (
    (scope?.worktreeId === worktreeId ? scope.repo.connectionId : getConnectionId(worktreeId)) ??
    undefined
  )
}
