import type { AppState } from '../../../types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorkspaceLineage } from '../../../../../../shared/worktree/lineage-types'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { FolderParentContext } from '@/components/sidebar/folder-workspace-parent-candidates'
import { captureFolderParentContext } from '@/components/sidebar/folder-workspace-parent-candidates'

export function findCapturedFolderParentChild(
  state: AppState,
  context: FolderParentContext
): Worktree | undefined {
  const matches = Object.values(state.worktreesByRepo)
    .flat()
    .filter(
      (row) =>
        row.identity?.key === context.identityKey &&
        row.instanceId === context.instanceId &&
        captureFolderParentContext(state, row)?.mutationKey === context.mutationKey
    )
  return matches.length === 1 ? matches[0] : undefined
}

export function projectConfirmedFolderParent(
  state: AppState,
  context: FolderParentContext,
  edge: WorkspaceLineage,
  baseline: Pick<AppState, 'worktreeLineageById' | 'workspaceLineageByChildKey'>
): Partial<AppState> | null {
  const child = findCapturedFolderParentChild(state, context)
  if (!child || edge.childInstanceId !== context.instanceId) {
    return null
  }
  const key = worktreeWorkspaceKey(child.id)
  if (edge.childWorkspaceKey !== key) {
    return null
  }
  const current = state.workspaceLineageByChildKey[key]
  if (
    current !== baseline.workspaceLineageByChildKey[key] &&
    (current?.childInstanceId !== edge.childInstanceId ||
      current?.parentWorkspaceKey !== edge.parentWorkspaceKey)
  ) {
    return null
  }
  const previousGit = state.worktreeLineageById[child.id]
  if (previousGit && previousGit.worktreeInstanceId !== context.instanceId) {
    return null
  }
  const lineage = { ...state.worktreeLineageById }
  delete lineage[child.id]
  const worktreesByRepo = Object.fromEntries(
    Object.entries(state.worktreesByRepo).map(([repoId, rows]) => [
      repoId,
      rows.map((row) => {
        if (row.identity?.key === context.identityKey && row.instanceId === context.instanceId) {
          return { ...row, parentWorktreeId: null, lineage: null }
        }
        if (
          previousGit &&
          row.id === previousGit.parentWorktreeId &&
          row.instanceId === previousGit.parentWorktreeInstanceId &&
          captureFolderParentContext(state, row)?.runtimeEnvironmentId ===
            context.runtimeEnvironmentId
        ) {
          return {
            ...row,
            childWorktreeIds:
              'childWorktreeIds' in row && Array.isArray(row.childWorktreeIds)
                ? row.childWorktreeIds.filter((id: unknown) => id !== child.id)
                : []
          }
        }
        return row
      })
    ])
  )
  return {
    worktreeLineageById: lineage,
    workspaceLineageByChildKey: { ...state.workspaceLineageByChildKey, [key]: edge },
    worktreesByRepo,
    sortEpoch: state.sortEpoch + 1
  }
}
