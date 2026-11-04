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
import {
  resumeWorkspaceKey,
  type ResumeWorkspaceGroup
} from './native-chat-resume-on-restart-grouping'
import type { Worktree } from '../../../shared/worktree/types'
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

/** Each offer's ancestors as offer keys (see resumeWorkspaceKey), nearest first, by the sidebar's own nesting rule. */
export function useResumeLineageAncestors(
  workspaces: readonly ResumeWorkspaceGroup[]
): (key: string) => readonly string[] {
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
    // Why: a hostless (older) row names an offer only when exactly one machine offers that id.
    const soleOfferById = new Map<string, ResumeWorkspaceGroup | null>()
    for (const group of workspaces) {
      soleOfferById.set(group.workspaceId, soleOfferById.has(group.workspaceId) ? null : group)
    }
    const offerKeyOfRow = (row: Worktree): string | undefined => {
      if (row.hostId) {
        return composeWorktreeHostIdentity(row.hostId, row.id)
      }
      const sole = soleOfferById.get(row.id)
      return sole ? resumeWorkspaceKey(sole) : undefined
    }
    const ancestors = new Map<string, readonly string[]>()
    for (const group of workspaces) {
      // Why: a row with no host id (older metadata) is still the chat's workspace.
      const target =
        getWorktreeOnHostFromState(
          state,
          group.workspaceId,
          group.candidates[0]?.executionHostId
        ) ?? rows.get(composeWorktreeHostIdentity(undefined, group.workspaceId))
      const parents = target
        ? getSidebarLineageAncestors(target, worktreeLineageById, rows, cyclic, parentIdentities)
        : []
      ancestors.set(
        resumeWorkspaceKey(group),
        parents.flatMap((parent) => offerKeyOfRow(parent) ?? [])
      )
    }
    return (key) => ancestors.get(key) ?? []
  }, [workspaces, worktreesByRepo, worktreeLineageById, parentIdentities])
}
