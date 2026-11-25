import { useMemo } from 'react'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { RenderRow } from '../listing/render-row'
import { getProjectGroupAncestorsByRowIndex } from './project-group-drop-target'
import type { ProjectHeaderGroupMove } from './project-header-group-move'

export function useProjectHeaderGroupMove(args: {
  enabled: boolean
  renderRows: readonly RenderRow[]
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<string, readonly string[]>
  projectGroupOwnerHostIdByGroupId: ReadonlyMap<string, ExecutionHostId | null>
  moveProjectToGroup: (project: Repo, groupId: string | null, order?: number) => Promise<boolean>
  onCommitRootProjectOrder: (
    visibleKeys: readonly string[],
    draggedKey: string,
    dropIndex: number
  ) => void
  onScrollIntent: () => void
}): ProjectHeaderGroupMove | undefined {
  const {
    enabled,
    renderRows,
    sidebarRepoHeaderIdsByBucket,
    projectGroupOwnerHostIdByGroupId,
    moveProjectToGroup,
    onCommitRootProjectOrder,
    onScrollIntent
  } = args
  const ancestorsByRowIndex = useMemo(
    () => (enabled ? getProjectGroupAncestorsByRowIndex(renderRows) : []),
    [enabled, renderRows]
  )
  return useMemo(() => {
    if (!enabled) {
      return undefined
    }
    return {
      rows: renderRows,
      ancestorsByRowIndex,
      sidebarRepoHeaderIdsByBucket,
      // Why: groups are host-owned; a project can only join one on its own host.
      canDropInto: (repo, groupId) =>
        projectGroupOwnerHostIdByGroupId.get(groupId) === getRepoExecutionHostId(repo),
      onCommitUngroup: (repo, rootOrder) => {
        onScrollIntent()
        void moveProjectToGroup(repo, null).then((moved) => {
          if (moved && rootOrder) {
            onCommitRootProjectOrder(rootOrder.visibleKeys, `repo:${repo.id}`, rootOrder.dropIndex)
          }
        })
      }
    }
  }, [
    ancestorsByRowIndex,
    enabled,
    moveProjectToGroup,
    onCommitRootProjectOrder,
    onScrollIntent,
    projectGroupOwnerHostIdByGroupId,
    renderRows,
    sidebarRepoHeaderIdsByBucket
  ])
}
