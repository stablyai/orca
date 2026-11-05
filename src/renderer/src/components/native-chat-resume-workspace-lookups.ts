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
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import {
  selectCrossStoreLineageParentIdentities,
  selectSidebarLineageParentIdentities
} from '@/store/cross-store-lineage-parents'
import { useAppStore } from '../store'
import type { ResumeWorkspaceGroup } from './native-chat-resume-on-restart-grouping'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

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

/** Each workspace's lineage ancestors, nearest first, by the sidebar's own nesting rule. */
export function useLineageAncestors(
  workspaces: readonly ResumeWorkspaceGroup[]
): (group: ResumeWorkspaceGroup) => readonly string[] {
  const worktreesByRepo = useAppStore((store) => selectWorktreesByRepo(store))
  const worktreeLineageById = useAppStore((store) => store.worktreeLineageById)
  const ancestors = useMemo(() => {
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
    return new Map(
      workspaces.map((group) => {
        // Why: a row with no host id (older metadata) is still the chat's workspace.
        const target =
          getWorktreeOnHostFromState(
            state,
            group.workspaceId,
            group.candidates[0]?.executionHostId
          ) ?? rows.get(composeWorktreeHostIdentity(undefined, group.workspaceId))
        const parents = target
          ? getSidebarLineageAncestors(target, worktreeLineageById, rows, cyclic)
          : []
        return [group, parents.map((parent) => parent.id)]
      })
    )
  }, [workspaces, worktreesByRepo, worktreeLineageById])
  return (group) => ancestors.get(group) ?? []
}

/** The offered workspace a chat's resolved cross-store parent chain reaches on another machine.
 * Only cross-store records start a chain; hostless offers are this computer's. */
export function useCrossStoreResumeParents(
  workspaces: readonly ResumeWorkspaceGroup[]
): (group: ResumeWorkspaceGroup) => ResumeWorkspaceGroup | undefined {
  const parents = useAppStore(selectSidebarLineageParentIdentities)
  const crossStoreParents = useAppStore(selectCrossStoreLineageParentIdentities)
  const parentByGroup = useMemo(() => {
    const result = new Map<ResumeWorkspaceGroup, ResumeWorkspaceGroup>()
    if (!parents || !crossStoreParents) {
      return result
    }
    const hostOf = (group: ResumeWorkspaceGroup): ExecutionHostId =>
      group.candidates[0]?.executionHostId ?? LOCAL_EXECUTION_HOST_ID
    const offerByIdentity = new Map<string, ResumeWorkspaceGroup>(
      workspaces.map((group) => [
        composeWorktreeHostIdentity(hostOf(group), group.workspaceId),
        group
      ])
    )
    for (const group of workspaces) {
      let identity = crossStoreParents.get(
        composeWorktreeHostIdentity(hostOf(group), group.workspaceId)
      )
      const seen = new Set<string>()
      while (identity !== undefined && !offerByIdentity.has(identity) && !seen.has(identity)) {
        seen.add(identity)
        identity = parents.get(identity)
      }
      const parent = identity === undefined ? undefined : offerByIdentity.get(identity)
      if (parent && hostOf(parent) !== hostOf(group)) {
        result.set(group, parent)
      }
    }
    return result
  }, [workspaces, parents, crossStoreParents])
  return (group) => parentByGroup.get(group)
}
