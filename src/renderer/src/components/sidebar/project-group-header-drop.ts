import {
  computeWorktreeSidebarHeaderDropPreview,
  type WorktreeSidebarHeaderDropPreview
} from './worktree-sidebar-header-drop-preview'
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
  sectionBottom?: number
}

export type ProjectGroupHeaderDropPreview = WorktreeSidebarHeaderDropPreview

export type ProjectGroupTabOrderUpdate = {
  groupId: string
  tabOrder: number
}

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

export function getProjectGroupTabOrderUpdatesForSidebarDrop(args: {
  sidebarProjectGroupHeaderIds: readonly string[]
  draggedGroupId: string
  sidebarDropIndex: number
  projectGroupById: ReadonlyMap<string, ProjectGroup>
}): ProjectGroupTabOrderUpdate[] {
  const sourceIndex = args.sidebarProjectGroupHeaderIds.indexOf(args.draggedGroupId)
  if (sourceIndex === -1) {
    return []
  }
  const siblingIds = args.sidebarProjectGroupHeaderIds.filter(
    (groupId) => groupId !== args.draggedGroupId
  )
  const siblingDropIndex = mapSidebarProjectGroupDropIndexToSiblingInsertIndex({
    sidebarDropIndex: args.sidebarDropIndex,
    sourceIndex,
    siblingCount: siblingIds.length
  })
  const sourceIndexInSiblings = Math.min(sourceIndex, siblingIds.length)
  if (siblingDropIndex === sourceIndexInSiblings) {
    return []
  }

  const orderedIds = siblingIds.slice()
  orderedIds.splice(siblingDropIndex, 0, args.draggedGroupId)

  const updates: ProjectGroupTabOrderUpdate[] = []
  for (const [index, groupId] of orderedIds.entries()) {
    const group = args.projectGroupById.get(groupId)
    if (!group) {
      continue
    }
    // Why: legacy groups can all have tabOrder=0, so a one-row midpoint update
    // cannot express an insertion inside that equal-rank block.
    if (group.tabOrder !== index) {
      updates.push({ groupId, tabOrder: index })
    }
  }
  return updates
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

function getOptionalNumberAttribute(element: HTMLElement, attribute: string): number | undefined {
  const rawValue = element.getAttribute(attribute)
  if (rawValue === null) {
    return undefined
  }
  const value = Number(rawValue)
  return Number.isFinite(value) ? value : undefined
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
      bottom: top + rect.height,
      sectionBottom: getOptionalNumberAttribute(element, 'data-project-group-header-section-end')
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
  return computeWorktreeSidebarHeaderDropPreview({
    pointerY: args.pointerY,
    containerTop: args.containerTop,
    scrollTop: args.scrollTop,
    rects,
    headerCount: sidebarProjectGroupHeaderIds.length,
    getId: (rect) => rect.groupId
  })
}
