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
import type { Repo } from '../../../../shared/repo-types'

export function createProjectHeaderDragSession(args: {
  event: Pick<
    PointerEvent<HTMLElement>,
    'button' | 'target' | 'currentTarget' | 'pointerId' | 'clientX' | 'clientY'
  >
  repo: Repo
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
  const membershipBucketKey = getProjectHeaderDragBucketKey(args.repo)
  const renderedBucketKey = args.event.currentTarget.getAttribute('data-repo-header-bucket')
  const candidates = [
    membershipBucketKey,
    JSON.stringify([membershipBucketKey, true]),
    JSON.stringify([membershipBucketKey, false])
  ].filter((key) => args.sidebarRepoHeaderIdsByBucket.get(key)?.includes(args.repo.id))
  const bucketKey = renderedBucketKey
    ? candidates.find((key) => key === renderedBucketKey)
    : candidates.length === 1
      ? candidates[0]
      : undefined
  if (!bucketKey) {
    return null
  }
  const sidebarRepoHeaderIds = args.sidebarRepoHeaderIdsByBucket.get(bucketKey) ?? []
  // A lone project cannot move within its bucket; preserve the collapse click instead.
  if (sidebarRepoHeaderIds.length <= 1) {
    return null
  }
  const container = args.getScrollContainer()
  if (!container) {
    return null
  }
  const handleEl = args.event.currentTarget
  // Delay pointer capture until promotion so ordinary clicks can still toggle collapse.
  return {
    repo: args.repo,
    bucketKey,
    membershipBucketKey,
    fixedPinTier: bucketKey !== membershipBucketKey,
    sidebarRepoHeaderIds,
    pointerId: args.event.pointerId,
    headerRects: measureProjectHeaderDragRects(container, bucketKey),
    handleEl,
    startX: args.event.clientX,
    startY: args.event.clientY,
    latestPointerY: args.event.clientY,
    promoted: false
  }
}
