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
import type { Repo } from '../../../../shared/types'

export function createProjectHeaderDragSession(args: {
  event: PointerEvent<HTMLElement>
  repoId: string
  repoById: ReadonlyMap<string, Repo>
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<ProjectHeaderDragBucketKey, readonly string[]>
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
  const repo = args.repoById.get(args.repoId)
  if (!repo) {
    return null
  }
  const bucketKey = getProjectHeaderDragBucketKey(repo)
  const sidebarRepoHeaderIds = args.sidebarRepoHeaderIdsByBucket.get(bucketKey) ?? []
  const totalHeaders = Array.from(args.sidebarRepoHeaderIdsByBucket.values()).reduce(
    (sum, ids) => sum + ids.length,
    0
  )
  // Why: a project can now move across buckets, so arming requires only that some
  // other project exists somewhere, not that the source bucket has a sibling.
  if (totalHeaders <= 1) {
    return null
  }
  const container = args.getScrollContainer()
  if (!container) {
    return null
  }
  const handleEl = args.event.currentTarget
  // Why: defer setPointerCapture until the drag threshold is crossed so a
  // header click still reaches the inner collapse handler on pointerup.
  return {
    repoId: args.repoId,
    bucketKey,
    sidebarRepoHeaderIds,
    sidebarRepoHeaderIdsByBucketAll: args.sidebarRepoHeaderIdsByBucket,
    pointerId: args.event.pointerId,
    headerRects: measureProjectHeaderDragRects(container, bucketKey),
    handleEl,
    startX: args.event.clientX,
    startY: args.event.clientY,
    latestPointerY: args.event.clientY,
    promoted: false
  }
}
