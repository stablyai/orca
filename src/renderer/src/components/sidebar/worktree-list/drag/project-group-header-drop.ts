import {
  computeWorktreeSidebarHeaderDropPreview,
  type WorktreeSidebarHeaderDropPreview
} from './worktree-sidebar-header-drop-preview'
import {
  getHeaderVirtualRowInfo,
  getOptionalNumberAttribute,
  indexMountedVirtualRowBounds,
  resolveMeasuredSectionBottom
} from './header-drag-dom-measurement'
import type { Row } from '../../../../../../shared/sidebar-list/row-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'

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
    if (
      row.type !== 'header' ||
      row.repo ||
      row.repeated ||
      !isConcreteProjectGroup(row.projectGroup)
    ) {
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
  // Convert the row-model insertion slot to the sibling list with the dragged header removed.
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
    // Equal legacy ranks require updating the full order to represent an interior insertion.
    if (group.tabOrder !== index) {
      updates.push({ groupId, tabOrder: index })
    }
  }
  return updates
}

export function measureProjectGroupHeaderDragRects(
  container: HTMLElement,
  bucketKey?: ProjectGroupHeaderDragBucketKey
): ProjectGroupHeaderDragRect[] {
  const containerTop = container.getBoundingClientRect().top
  const mountedRows = indexMountedVirtualRowBounds(container)
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
    const { top, height, rowIndex } = getHeaderVirtualRowInfo(element, container, containerTop)
    const bottom = top + height
    rects.push({
      groupId,
      bucketKey: elementBucketKey,
      headerIndex,
      top,
      bottom,
      sectionBottom: resolveMeasuredSectionBottom({
        headerRowIndex: rowIndex,
        headerBottom: bottom,
        sectionEndIndex: getOptionalNumberAttribute(
          element,
          'data-project-group-header-section-end-index'
        ),
        estimatedSectionBottom: getOptionalNumberAttribute(
          element,
          'data-project-group-header-section-end'
        ),
        mountedRows
      })
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
  contentBottom?: number
}): ProjectGroupHeaderDropPreview | null {
  const { rects, sidebarProjectGroupHeaderIds } = args
  return computeWorktreeSidebarHeaderDropPreview({
    pointerY: args.pointerY,
    containerTop: args.containerTop,
    scrollTop: args.scrollTop,
    rects,
    headerCount: sidebarProjectGroupHeaderIds.length,
    getId: (rect) => rect.groupId,
    contentBottom: args.contentBottom
  })
}
