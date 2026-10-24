import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { getLineageInputs, requireKnownLineageRow } from './sidebar/visible-worktree-indexes'
import { useMemo } from 'react'
import {
  getSidebarLineageAncestors,
  findWorktreeLineageRow,
  getWorktreeLineageSelection
} from '../../../shared/sidebar-list/worktree-lineage-projection'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { useAppStore } from '../store'
import type { ResumeWorkspaceGroup } from './native-chat-resume-on-restart-grouping'

// Store lookups the resume tree makes for its workspaces, each on the workspace's own host.

/** The store's row for a workspace on its own host; folder workspaces included. Stable per row. */
export function useWorkspaceWorktree(workspaceId: string, hostId: ExecutionHostId | undefined) {
  return useAppStore((store) =>
    store.getKnownWorktreeById(workspaceId, hostId ?? LOCAL_EXECUTION_HOST_ID)
  )
}

/**
 * The repo owning each workspace, as one narrow subscription.
 *
 * Selected as a joined string rather than a map so the selector returns a PRIMITIVE: a fresh object
 * or array would fail the equality check on every store change and re-render the whole list.
 * Keyed by the group itself: the same workspace id can be listed on two machines.
 */
export function useRepoIdByWorkspace(
  workspaces: readonly ResumeWorkspaceGroup[]
): (group: ResumeWorkspaceGroup) => string | null {
  const ids = workspaces.map((group) => group.workspaceId)
  const hosts = workspaces.map(
    (group) => group.candidates[0]?.executionHostId ?? LOCAL_EXECUTION_HOST_ID
  )
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
  const inputs = useAppStore(getLineageInputs)
  const ancestors = useMemo(() => {
    const rows = inputs.worktreeMap
    const offered = new Map(
      workspaces.map((group) => {
        const host = group.candidates[0]?.executionHostId ?? LOCAL_EXECUTION_HOST_ID
        const state = useAppStore.getState()
        const known = state.getKnownWorktreeById(group.workspaceId, host)
        let row = known ? findWorktreeLineageRow(rows, known) : undefined
        if (row) {
          try {
            row = requireKnownLineageRow(state, row, host)
          } catch {
            row = undefined
          }
        }
        return [group, row] as const
      })
    )
    const membershipKey = (
      host: ExecutionHostId,
      row: NonNullable<ReturnType<typeof offered.get>>
    ) => JSON.stringify([host, row.repoId, getWorktreeLineageSelection(row)])
    const membership = new Set<string>()
    for (const [group, row] of offered) {
      if (row) {
        membership.add(
          membershipKey(group.candidates[0]?.executionHostId ?? LOCAL_EXECUTION_HOST_ID, row)
        )
      }
    }
    return new Map(
      workspaces.map((group) => {
        const target = offered.get(group)
        const parents = target ? getSidebarLineageAncestors(target, inputs.lineageById, rows) : []
        const host = group.candidates[0]?.executionHostId ?? LOCAL_EXECUTION_HOST_ID
        return [
          group,
          parents
            .filter(
              (parent) =>
                parent.repoId === target?.repoId && membership.has(membershipKey(host, parent))
            )
            .map((parent) => parent.id)
        ]
      })
    )
  }, [workspaces, inputs])
  return (group) => ancestors.get(group) ?? []
}
