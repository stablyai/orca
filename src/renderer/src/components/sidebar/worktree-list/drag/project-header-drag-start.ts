import {
  getRootProjectHeaderDragKeys,
  measureRootProjectHeaderDragRects
} from './root-project-header-drop'
import type { PointerEvent } from 'react'

import {
  getProjectHeaderDragBucketKey,
  measureProjectHeaderDragRects,
  type ProjectHeaderDragBucketKey
} from './project-header-drop'
import {
  isProjectHeaderDragHandleTarget,
  isRepoHeaderActionTarget,
  type ProjectHeaderDragSession
} from './project-header-drag-contract'
import type { ProjectHeaderGroupMove } from './project-header-group-move'
import { getProjectGroupDragSource } from './project-group-drop-target'
import type { Repo } from '../../../../../../shared/repository/repo-types'

export function createProjectHeaderDragSession(args: {
  event: PointerEvent<HTMLElement>
  repo: Repo
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<ProjectHeaderDragBucketKey, readonly string[]>
  rootProjectHeaderKeys?: readonly string[]
  canReorder: boolean
  groupMove?: ProjectHeaderGroupMove
  getScrollContainer: () => HTMLElement | null
}): ProjectHeaderDragSession | null {
  if (args.event.button !== 0) {
    return null
  }
  if (!isProjectHeaderDragHandleTarget(args.event.target, args.event.currentTarget)) {
    return null
  }
  if (isRepoHeaderActionTarget(args.event.target, args.event.currentTarget)) {
    return null
  }
  const bucketKey = getProjectHeaderDragBucketKey(args.repo)
  const rootProjectHeaderHostId = args.rootProjectHeaderKeys?.some((key) => key.startsWith('host:'))
    ? args.event.currentTarget.dataset.rootProjectHeaderHost
    : undefined
  const rootProjectHeaderKeys = getRootProjectHeaderDragKeys(
    args.rootProjectHeaderKeys,
    `repo:${args.repo.id}`,
    rootProjectHeaderHostId
  )
  const sidebarRepoHeaderIds =
    rootProjectHeaderKeys ?? args.sidebarRepoHeaderIdsByBucket.get(bucketKey) ?? []
  // A lone project cannot move within its bucket; preserve the collapse click unless it can change group.
  if (!args.groupMove && (!args.canReorder || sidebarRepoHeaderIds.length <= 1)) {
    return null
  }
  const container = args.getScrollContainer()
  if (!container) {
    return null
  }
  const handleEl = args.event.currentTarget
  const rowIndex = Number(
    handleEl.closest<HTMLElement>('[data-worktree-virtual-row]')?.dataset.index
  )
  const source =
    args.groupMove && Number.isFinite(rowIndex)
      ? getProjectGroupDragSource(args.groupMove.rows, args.groupMove.ancestorsByRowIndex, rowIndex)
      : { sourceGroupId: args.repo.projectGroupId ?? null }
  // Delay pointer capture until promotion so ordinary clicks can still toggle collapse.
  return {
    repo: args.repo,
    bucketKey,
    sidebarRepoHeaderIds,
    pointerId: args.event.pointerId,
    rootProjectHeaderKeys,
    rootProjectHeaderHostId,
    ...source,
    headerRects: rootProjectHeaderKeys
      ? measureRootProjectHeaderDragRects(
          container,
          rootProjectHeaderKeys,
          rootProjectHeaderHostId
        ).map((rect) => ({
          ...rect,
          repoId: rect.key
        }))
      : measureProjectHeaderDragRects(container, bucketKey),
    handleEl,
    startX: args.event.clientX,
    startY: args.event.clientY,
    latestPointerY: args.event.clientY,
    promoted: false
  }
}
