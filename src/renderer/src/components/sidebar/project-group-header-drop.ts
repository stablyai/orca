import { getWorktreeSidebarBoundaryDrop } from './worktree-sidebar-drag-autoscroll'
import type { Row } from './worktree-list-groups'
import type { ProjectGroup } from '../../../../shared/types'

export type ProjectGroupHeaderDragBucketKey = string

export type ProjectGroupHeaderDragRect = {
  groupId: string
  bucketKey: ProjectGroupHeaderDragBucketKey
  // Index among sibling Project Group headers in the row model, not mounted DOM.
  headerIndex: number
  top: number
  bottom: number
}

export type ProjectGroupHeaderDropPreview = {
  dropIndex: number
  dropIndicatorY: number
}

const INDICATOR_GAP_PX = 4
const ROOT_PROJECT_GROUP_HEADER_BUCKET = 'root'

type SidebarProjectGroupHeader = ProjectGroup | { id: null } | undefined

function isConcreteProjectGroup(
  projectGroup: SidebarProjectGroupHeader
): projectGroup is ProjectGroup {
  return typeof projectGroup?.id === 'string'
}

export function getProjectGroupHeaderDragBucketKey(
  group: Pick<ProjectGroup, 'parentGroupId'>,
  projectGroupById?: ReadonlyMap<string, ProjectGroup>
): ProjectGroupHeaderDragBucketKey {
  const parentGroupId = group.parentGroupId ?? null
  if (!parentGroupId) {
    return ROOT_PROJECT_GROUP_HEADER_BUCKET
  }
  if (projectGroupById && !projectGroupById.has(parentGroupId)) {
    return ROOT_PROJECT_GROUP_HEADER_BUCKET
  }
  return `parent:${parentGroupId}`
}

export function getSidebarOrderedProjectGroupHeaderIdsByBucket(
  rows: readonly Row[],
  projectGroupById?: ReadonlyMap<string, ProjectGroup>
): Map<ProjectGroupHeaderDragBucketKey, string[]> {
  const buckets = new Map<ProjectGroupHeaderDragBucketKey, string[]>()
  for (const row of rows) {
    if (row.type !== 'header' || row.repo || !isConcreteProjectGroup(row.projectGroup)) {
      continue
    }
    const bucketKey = getProjectGroupHeaderDragBucketKey(row.projectGroup, projectGroupById)
    const list = buckets.get(bucketKey) ?? []
    list.push(row.projectGroup.id)
    buckets.set(bucketKey, list)
  }
  return buckets
}

export function getProjectGroupTabOrderForSidebarDrop(args: {
  siblings: readonly ProjectGroup[]
  dropIndex: number
}): number {
  const ordered = args.siblings.slice()
  if (ordered.length === 0) {
    return 0
  }
  const getOrder = (group: ProjectGroup | undefined): number | undefined =>
    group && Number.isFinite(group.tabOrder) ? group.tabOrder : undefined
  const before = getOrder(ordered[args.dropIndex - 1])
  const after = getOrder(ordered[args.dropIndex])
  if (before === undefined && after === undefined) {
    return 0
  }
  if (before === undefined) {
    return after !== undefined ? after - 1 : 0
  }
  if (after === undefined) {
    return before + 1
  }
  if (after > before) {
    const midpoint = before + (after - before) / 2
    return Number.isFinite(midpoint) ? midpoint : before / 2 + after / 2
  }
  // Why: duplicate legacy ranks leave no slot between siblings; a finite anchor
  // lets the next drag establish a stable persisted order.
  return before + 1
}

export function mapSidebarProjectGroupDropIndexToSiblingInsertIndex(args: {
  sidebarDropIndex: number
  sourceIndex: number
  siblingCount: number
}): number {
  // Why: sidebar drop indices include the dragged header, but tabOrder is
  // computed against the sibling list after that header is removed.
  const adjustedDropIndex =
    args.sourceIndex >= 0 && args.sidebarDropIndex > args.sourceIndex
      ? args.sidebarDropIndex - 1
      : args.sidebarDropIndex
  return Math.max(0, Math.min(args.siblingCount, adjustedDropIndex))
}

function getVirtualRowStart(virtualRow: HTMLElement | null): number | null {
  if (!virtualRow) {
    return null
  }
  const rawStart = virtualRow.getAttribute('data-worktree-virtual-row-start')
  if (rawStart === null) {
    return null
  }
  const start = Number(rawStart)
  return Number.isFinite(start) ? start : null
}

export function measureProjectGroupHeaderDragRects(
  container: HTMLElement,
  bucketKey?: ProjectGroupHeaderDragBucketKey
): ProjectGroupHeaderDragRect[] {
  const containerRect = container.getBoundingClientRect()
  const rects: ProjectGroupHeaderDragRect[] = []
  container.querySelectorAll<HTMLElement>('[data-project-group-header-id]').forEach((element) => {
    const groupId = element.getAttribute('data-project-group-header-id')
    const elementBucketKey = element.getAttribute('data-project-group-header-bucket')
    const rawHeaderIndex = element.getAttribute('data-project-group-header-index')
    const headerIndex = rawHeaderIndex === null ? Number.NaN : Number(rawHeaderIndex)
    if (!groupId || !elementBucketKey || !Number.isFinite(headerIndex)) {
      return
    }
    if (bucketKey !== undefined && elementBucketKey !== bucketKey) {
      return
    }
    const rect = element.getBoundingClientRect()
    const virtualRow = element.closest<HTMLElement>('[data-worktree-virtual-row]')
    const virtualRowStart = getVirtualRowStart(virtualRow)
    const top =
      virtualRow && virtualRowStart !== null
        ? virtualRowStart + rect.top - virtualRow.getBoundingClientRect().top
        : rect.top - containerRect.top + container.scrollTop
    rects.push({
      groupId,
      bucketKey: elementBucketKey,
      headerIndex,
      top,
      bottom: top + rect.height
    })
  })
  rects.sort((left, right) => left.top - right.top)
  return rects
}

export function computeProjectGroupHeaderDropPreview(args: {
  pointerY: number
  containerTop: number
  scrollTop: number
  rects: readonly ProjectGroupHeaderDragRect[]
  sidebarProjectGroupHeaderIds: readonly string[]
}): ProjectGroupHeaderDropPreview | null {
  const { rects, sidebarProjectGroupHeaderIds } = args
  if (rects.length === 0 || sidebarProjectGroupHeaderIds.length === 0) {
    return null
  }

  const localY = args.pointerY - args.containerTop + args.scrollTop
  const first = rects[0]!
  const last = rects.at(-1)!
  const boundaryDrop = getWorktreeSidebarBoundaryDrop({
    localY,
    firstRect: {
      worktreeId: first.groupId,
      groupIndex: first.headerIndex,
      top: first.top,
      bottom: first.bottom
    },
    lastRect: {
      worktreeId: last.groupId,
      groupIndex: last.headerIndex,
      top: last.top,
      bottom: last.bottom
    },
    sourceGroupSize: sidebarProjectGroupHeaderIds.length
  })
  if (boundaryDrop.kind === 'outside') {
    return null
  }

  let dropIndex = last.headerIndex + 1
  let indicatorY = last.bottom + INDICATOR_GAP_PX
  if (boundaryDrop.kind === 'drop') {
    dropIndex = boundaryDrop.dropIndex
    indicatorY = boundaryDrop.indicatorY
  } else {
    for (const rect of rects) {
      const mid = (rect.top + rect.bottom) / 2
      if (localY < mid) {
        dropIndex = rect.headerIndex
        indicatorY = Math.max(0, rect.top - INDICATOR_GAP_PX)
        break
      }
    }
  }

  return {
    dropIndex,
    dropIndicatorY: Math.max(args.scrollTop, indicatorY)
  }
}
