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
import {
  encodeSidebarRootSlotKey,
  measureSidebarRootSlotDragRects,
  type SidebarRootSlot
} from './sidebar-root-slot-order'
import type { Repo } from '../../../../shared/types'

export function createProjectHeaderDragSession(args: {
  event: PointerEvent<HTMLElement>
  repoId: string
  repoById: ReadonlyMap<string, Repo>
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<ProjectHeaderDragBucketKey, readonly string[]>
  sidebarRootSlots: readonly SidebarRootSlot[]
  usesProjectGroupOrdering: boolean
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
  const usesRootSlotOrdering =
    args.usesProjectGroupOrdering && bucketKey === 'ungrouped' && args.sidebarRootSlots.length > 1
  const sidebarRepoHeaderIds = args.sidebarRepoHeaderIdsByBucket.get(bucketKey) ?? []
  // Why: a single project in its bucket has nowhere to land, so skip arming
  // drag and let the header click toggle collapse instead. Root interleave can
  // still move one ungrouped project against groups.
  if (!usesRootSlotOrdering && sidebarRepoHeaderIds.length <= 1) {
    return null
  }
  if (usesRootSlotOrdering && args.sidebarRootSlots.length <= 1) {
    return null
  }
  const container = args.getScrollContainer()
  if (!container) {
    return null
  }
  const handleEl = args.event.currentTarget
  const orderedRootSlots = usesRootSlotOrdering ? args.sidebarRootSlots : null
  // Why: defer setPointerCapture until the drag threshold is crossed so a
  // header click still reaches the inner collapse handler on pointerup.
  return {
    repoId: args.repoId,
    bucketKey,
    sidebarRepoHeaderIds: usesRootSlotOrdering
      ? orderedRootSlots!.map(encodeSidebarRootSlotKey)
      : sidebarRepoHeaderIds,
    orderedRootSlots,
    pointerId: args.event.pointerId,
    headerRects: usesRootSlotOrdering
      ? measureSidebarRootSlotDragRects(container)
      : measureProjectHeaderDragRects(container, bucketKey),
    handleEl,
    startX: args.event.clientX,
    startY: args.event.clientY,
    latestPointerY: args.event.clientY,
    promoted: false
  }
}
