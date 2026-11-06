import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import type { Repo } from '../../../../../../shared/repo-types'
import type { AttachedWorktreeOwner } from '../../folder-workspace-attached-worktrees'

export type SourceControlScope = AttachedWorktreeOwner & {
  repo: Repo
  placementWorkspaceId: string
}
/** Routing fields only, so worktree record churn (activity, unread, metadata) cannot refire scoped Git work. */
export type SourceControlScopeRouting = Pick<
  SourceControlScope,
  'worktreeId' | 'repoId' | 'executionHostId' | 'placementWorkspaceId'
> & {
  connectionId: string | null
  runtimeOwnerEnvironmentId: string | undefined
}
const WorktreeScope = createContext<SourceControlScopeRouting | null>(null)
const WorktreeScopeOwner = createContext<SourceControlScope | null>(null)
// Why default true: the selected workspace's panel has no section gate, as on main.
const SectionActive = createContext(true)
const mountedScopeCounts = new Map<string, number>()

/** Whether a folder section for this worktree is on screen, so its row actions can still apply. */
export function isSourceControlScopeMounted(worktreeId: string | null): boolean {
  return worktreeId !== null && mountedScopeCounts.has(worktreeId)
}
export function SourceControlScopeProvider({
  owner,
  active = true,
  children
}: {
  owner: SourceControlScope
  /** Expanded and on screen; inactive sections keep their view state but run no Git or review work. */
  active?: boolean
  children?: ReactNode
}) {
  const { worktreeId, repoId, executionHostId, placementWorkspaceId } = owner
  const connectionId = owner.repo.connectionId ?? null
  const runtimeOwnerEnvironmentId = owner.worktree.runtimeOwnerEnvironmentId
  const routing = useMemo(
    () => ({
      worktreeId,
      repoId,
      executionHostId,
      placementWorkspaceId,
      connectionId,
      runtimeOwnerEnvironmentId
    }),
    [
      worktreeId,
      repoId,
      executionHostId,
      placementWorkspaceId,
      connectionId,
      runtimeOwnerEnvironmentId
    ]
  )
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
  return (
    <WorktreeScopeOwner.Provider value={owner}>
      <WorktreeScope.Provider value={routing}>
        <SectionActive.Provider value={active}>{children}</SectionActive.Provider>
      </WorktreeScope.Provider>
    </WorktreeScopeOwner.Provider>
  )
}
export function useSourceControlScope(): SourceControlScopeRouting | null {
  return useContext(WorktreeScope)
}
/** Whether this panel may run Git/review work: always for the selected panel, expanded and on screen for a section. */
export function useSourceControlSectionActive(): boolean {
  return useContext(SectionActive)
}
/** The section's live worktree and repo records, for display state that must follow record updates. */
export function useSourceControlScopeOwner(): SourceControlScope | null {
  return useContext(WorktreeScopeOwner)
}

/** The section's runtime environment, falling back to a runtime execution host. */
export function sourceControlScopeRuntimeEnvironmentId(
  scope: SourceControlScopeRouting | null
): string | null | undefined {
  if (!scope) {
    return undefined
  }
  return (
    scope.runtimeOwnerEnvironmentId ??
    (scope.executionHostId.startsWith('runtime:')
      ? decodeURIComponent(scope.executionHostId.slice(8))
      : null)
  )
}

/** A folder section's repo connection for its own worktree; otherwise the selected copy's. */
export function sourceControlConnectionId(
  scope: SourceControlScopeRouting | null,
  worktreeId: string | null
): string | undefined {
  return (
    (scope?.worktreeId === worktreeId ? scope.connectionId : getConnectionId(worktreeId)) ??
    undefined
  )
}
