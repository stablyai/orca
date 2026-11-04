import { useMemo } from 'react'
import {
  getCyclicProjectedWorktreeLineageIds,
  getSidebarLineageAncestors
} from '../../../shared/sidebar-list/worktree-lineage-projection'
import {
  getAllWorktreesFromState,
  getWorktreeMapFromState,
  getWorktreeOnHostFromState
} from '@/store/selectors'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { useAppStore } from '../store'
import type { ResumeWorkspaceGroup } from './native-chat-resume-on-restart-grouping'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { selectSidebarLineageParentIdentities } from '@/store/cross-store-lineage-parents'

/** The store's row for a workspace on its own host; folder workspaces included. Stable per row. */
export function useWorkspaceWorktree(workspaceId: string, hostId: ExecutionHostId | undefined) {
  return useAppStore((store) => store.getKnownWorktreeById(workspaceId, hostId))
}

/** Use a primitive snapshot to avoid list rerenders on unrelated writes; group identity distinguishes twin workspace ids across hosts. */
export function useRepoIdByWorkspace(
  workspaces: readonly ResumeWorkspaceGroup[]
): (group: ResumeWorkspaceGroup) => string | null {
  const ids = workspaces.map((group) => group.workspaceId)
  const hosts = workspaces.map((group) => group.candidates[0]?.executionHostId)
  const joined = useAppStore((store) =>
    ids.map((id, index) => store.getKnownWorktreeById(id, hosts[index])?.repoId ?? '').join('\0')
  )
  const repoIds = joined.split('\0')
  return (group) => {
    const index = workspaces.indexOf(group)
    const repoId = index === -1 ? '' : (repoIds[index] ?? '')
    return repoId === '' ? null : repoId
  }
}

export type ResumeLineage = {
  /** Host-qualified so same-id workspaces on two machines stay distinct. */
  keyOf: (group: ResumeWorkspaceGroup) => string
  /** Host-qualified ancestor keys, nearest first, by the sidebar's own nesting rule. */
  ancestorsOf: (key: string) => readonly string[]
}

export function useResumeLineage(workspaces: readonly ResumeWorkspaceGroup[]): ResumeLineage {
  const worktreesByRepo = useAppStore((store) => selectWorktreesByRepo(store))
  const worktreeLineageById = useAppStore((store) => store.worktreeLineageById)
  const parentIdentities = useAppStore(selectSidebarLineageParentIdentities)
  return useMemo(() => {
    const state = { worktreesByRepo }
    // Why: archived rows never render in the sidebar, so nothing nests under them.
    const rows = new Map(
      getAllWorktreesFromState(state)
        .filter((worktree) => !worktree.isArchived)
        .map((worktree) => [getWorktreeHostIdentity(worktree), worktree])
    )
    const cyclic = getCyclicProjectedWorktreeLineageIds(
      worktreeLineageById,
      getWorktreeMapFromState(state)
    )
    const keys = new Map<ResumeWorkspaceGroup, string>()
    const ancestors = new Map<string, readonly string[]>()
    for (const group of workspaces) {
      const hostId = group.candidates[0]?.executionHostId
      // Why: a row with no host id (older metadata) is still the chat's workspace.
      const target =
        getWorktreeOnHostFromState(state, group.workspaceId, hostId) ??
        rows.get(composeWorktreeHostIdentity(undefined, group.workspaceId))
      const key = target
        ? getWorktreeHostIdentity(target)
        : composeWorktreeHostIdentity(hostId, group.workspaceId)
      keys.set(group, key)
      const parents = target
        ? getSidebarLineageAncestors(target, worktreeLineageById, rows, cyclic, parentIdentities)
        : []
      ancestors.set(key, parents.map(getWorktreeHostIdentity))
    }
    return {
      keyOf: (group) =>
        keys.get(group) ??
        composeWorktreeHostIdentity(group.candidates[0]?.executionHostId, group.workspaceId),
      ancestorsOf: (key) => ancestors.get(key) ?? []
    }
  }, [workspaces, worktreesByRepo, worktreeLineageById, parentIdentities])
}
