import { useMemo } from 'react'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { RenderRow } from '../listing/render-row'
import { getProjectGroupAncestorsByRowIndex } from './project-group-drop-target'
import type { ProjectHeaderGroupMove } from './project-header-group-move'
import { canProjectJoinGroupHost } from '@/store/project-groups/project-group-remote-members'

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
      // Why: a project joins its own host's groups, or this client's groups when it lives elsewhere.
      canDropInto: (repo, groupId) =>
        canProjectJoinGroupHost(
          getRepoExecutionHostId(repo),
          projectGroupOwnerHostIdByGroupId.get(groupId)
        ),
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
