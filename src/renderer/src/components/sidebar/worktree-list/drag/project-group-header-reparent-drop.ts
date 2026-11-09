import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { getProjectGroupSubtreeIds } from '../../../../../../shared/project-groups'
import { readHostHeaderRects, type HostHeaderRect } from './host-header-drag-dom'
import {
  findInnermostEnclosingGroupRect,
  getCatalogHostIdForExecutionHost,
  isGroupHeaderBandHit,
  resolveHostSectionBounds
} from './group-header-hit-geometry'
import {
  computeProjectGroupHeaderDropPreview,
  getProjectGroupHeaderDragBucketKey,
  measureProjectGroupHeaderDragRects,
  type ProjectGroupHeaderDragBucketKey,
  type ProjectGroupHeaderDragRect
} from './project-group-header-drop'
import {
  ROOT_INTERLEAVED_GROUP_BUCKET_KEY,
  type ProjectGroupDragState,
  type ProjectGroupHeaderDragSession
} from './project-group-header-drag-contract'
import { measureRootProjectHeaderDragRects } from './root-project-header-drop'
import {
  filterProjectGroupIdsByCatalogHost,
  resolveNestedGroupExitToGrandparentSlot
} from './project-group-nested-exit-drop'

export { filterProjectGroupIdsByCatalogHost }

export type ProjectGroupHeaderDropTarget =
  | { kind: 'group-header'; groupId: string }
  | {
      kind: 'slot'
      targetBucketKey: ProjectGroupHeaderDragBucketKey
      dropIndex: number
      dropIndicatorY: number
    }

const ROOT_TAIL_SLOP_PX = 32
const NESTED_EXIT_TAIL_SLOP_PX = 56
const INDICATOR_GAP_PX = 4

export function parseParentGroupIdFromBucketKey(
  bucketKey: ProjectGroupHeaderDragBucketKey
): string | null {
  return bucketKey.startsWith('parent:') ? bucketKey.slice('parent:'.length) : null
}

export function getReparentableTargetGroupIdsForGroup(
  group: ProjectGroup,
  projectGroups: readonly ProjectGroup[]
): Set<string> {
  const ownerHostId = getRepoExecutionHostId(group)
  if (!getCatalogHostIdForExecutionHost(ownerHostId)) {
    return new Set()
  }
  const sameHostGroups = projectGroups.filter(
    (candidate) => getRepoExecutionHostId(candidate) === ownerHostId
  )
  const subtreeIds = getProjectGroupSubtreeIds(sameHostGroups, group.id)
  const ids = new Set<string>()
  for (const candidate of sameHostGroups) {
    if (!subtreeIds.has(candidate.id)) {
      ids.add(candidate.id)
    }
  }
  return ids
}

export function canProjectGroupStartHeaderDrag(args: {
  group: ProjectGroup
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  sidebarBucketHeaderIds: readonly string[]
  rootProjectHeaderCount?: number
  reparentableGroupIds: ReadonlySet<string>
}): boolean {
  const bucketKey = getProjectGroupHeaderDragBucketKey(args.group, args.projectGroupById)
  if (bucketKey !== 'root') {
    return true
  }
  if ((args.rootProjectHeaderCount ?? 0) > 1) {
    return true
  }
  const sameHostIds = filterProjectGroupIdsByCatalogHost(
    args.sidebarBucketHeaderIds,
    getRepoExecutionHostId(args.group),
    args.projectGroupById
  )
  if (sameHostIds.length > 1) {
    return true
  }
  const currentParentGroupId = parseParentGroupIdFromBucketKey(bucketKey)
  for (const id of args.reparentableGroupIds) {
    if (id !== currentParentGroupId) {
      return true
    }
  }
  return false
}

export function computeCombinedProjectGroupHeaderDropTarget(args: {
  pointerY: number
  containerTop: number
  scrollTop: number
  dragHostId?: ExecutionHostId
  draggedGroup: ProjectGroup
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  reparentableGroupIds: ReadonlySet<string>
  hostHeaderRects?: readonly HostHeaderRect[]
  groupHeaderRects: readonly ProjectGroupHeaderDragRect[]
  rootProjectHeaderKeys?: readonly string[]
  rootHeaderRects?: readonly ProjectGroupHeaderDragRect[]
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
    ProjectGroupHeaderDragBucketKey,
    readonly string[]
  >
  contentBottom?: number
}): ProjectGroupHeaderDropTarget | null {
  const localY = args.pointerY - args.containerTop + args.scrollTop
  const currentBucketKey = getProjectGroupHeaderDragBucketKey(
    args.draggedGroup,
    args.projectGroupById
  )
  const currentParentGroupId = parseParentGroupIdFromBucketKey(currentBucketKey)
  const tailAllowancePx = currentBucketKey !== 'root' ? NESTED_EXIT_TAIL_SLOP_PX : ROOT_TAIL_SLOP_PX
  const maxContentY =
    args.contentBottom !== undefined ? args.contentBottom + tailAllowancePx : undefined
  if (maxContentY !== undefined && localY > maxContentY) {
    return null
  }

  const hostSectionBounds = resolveHostSectionBounds(args.dragHostId, args.hostHeaderRects)
  if (hostSectionBounds && (localY < hostSectionBounds.top || localY >= hostSectionBounds.bottom)) {
    return null
  }

  for (const groupRect of args.groupHeaderRects) {
    if (localY < groupRect.top || localY > groupRect.bottom) {
      continue
    }
    if (groupRect.groupId === args.draggedGroup.id) {
      return null
    }
    if (!args.reparentableGroupIds.has(groupRect.groupId)) {
      return null
    }
    if (isGroupHeaderBandHit(localY, groupRect)) {
      if (groupRect.groupId === currentParentGroupId) {
        return null
      }
      return { kind: 'group-header', groupId: groupRect.groupId }
    }
  }

  const excludedEnclosureIds = new Set<string>()
  for (const rect of args.groupHeaderRects) {
    if (!args.reparentableGroupIds.has(rect.groupId)) {
      excludedEnclosureIds.add(rect.groupId)
    }
  }
  const enclosingGroup = findInnermostEnclosingGroupRect(
    localY,
    args.groupHeaderRects,
    excludedEnclosureIds
  )
  if (!enclosingGroup) {
    const grandparentExitSlot = resolveNestedGroupExitToGrandparentSlot({
      localY,
      scrollTop: args.scrollTop,
      dragHostId: args.dragHostId ?? getRepoExecutionHostId(args.draggedGroup),
      currentParentGroupId,
      projectGroupById: args.projectGroupById,
      reparentableGroupIds: args.reparentableGroupIds,
      groupHeaderRects: args.groupHeaderRects,
      sidebarProjectGroupHeaderIdsByBucket: args.sidebarProjectGroupHeaderIdsByBucket,
      hostSectionBottom: hostSectionBounds?.bottom
    })
    if (grandparentExitSlot) {
      return grandparentExitSlot
    }
    if (
      args.rootProjectHeaderKeys &&
      args.rootHeaderRects &&
      (currentBucketKey === 'root' || args.rootProjectHeaderKeys.length > 0)
    ) {
      const rootPreview = computeProjectGroupHeaderDropPreview({
        pointerY: args.pointerY,
        containerTop: args.containerTop,
        scrollTop: args.scrollTop,
        rects: args.rootHeaderRects,
        sidebarProjectGroupHeaderIds: args.rootProjectHeaderKeys,
        contentBottom: currentBucketKey !== 'root' ? maxContentY : args.contentBottom
      })
      if (!rootPreview) {
        return null
      }
      return {
        kind: 'slot',
        targetBucketKey: ROOT_INTERLEAVED_GROUP_BUCKET_KEY,
        dropIndex: rootPreview.dropIndex,
        dropIndicatorY: rootPreview.dropIndicatorY
      }
    }
  }

  const targetBucketKey: ProjectGroupHeaderDragBucketKey = enclosingGroup
    ? `parent:${enclosingGroup.groupId}`
    : 'root'
  const bucketHeaderIds = filterProjectGroupIdsByCatalogHost(
    args.sidebarProjectGroupHeaderIdsByBucket.get(targetBucketKey) ?? [],
    args.dragHostId ?? getRepoExecutionHostId(args.draggedGroup),
    args.projectGroupById
  )
  const bucketHeaderIndexById = new Map(bucketHeaderIds.map((id, index) => [id, index]))
  const bucketRects = args.groupHeaderRects
    .filter((rect) => {
      if (rect.bucketKey !== targetBucketKey || !bucketHeaderIndexById.has(rect.groupId)) {
        return false
      }
      if (!hostSectionBounds) {
        return true
      }
      return rect.top >= hostSectionBounds.top && rect.top < hostSectionBounds.bottom
    })
    .map((rect) => ({
      ...rect,
      headerIndex: bucketHeaderIndexById.get(rect.groupId) ?? rect.headerIndex
    }))

  if (
    enclosingGroup &&
    (bucketHeaderIds.length === 0 || (hostSectionBounds !== null && bucketRects.length === 0))
  ) {
    if (enclosingGroup.groupId === currentParentGroupId) {
      return null
    }
    const anchorY = enclosingGroup.sectionBottom ?? enclosingGroup.bottom
    return {
      kind: 'slot',
      targetBucketKey,
      dropIndex: 0,
      dropIndicatorY: Math.max(args.scrollTop, anchorY + INDICATOR_GAP_PX)
    }
  }

  const previewContentBottom =
    targetBucketKey !== currentBucketKey ? maxContentY : args.contentBottom
  const preview = computeProjectGroupHeaderDropPreview({
    pointerY: args.pointerY,
    containerTop: args.containerTop,
    scrollTop: args.scrollTop,
    rects: bucketRects,
    sidebarProjectGroupHeaderIds: bucketHeaderIds,
    contentBottom: previewContentBottom
  })
  if (!preview) {
    return null
  }
  return {
    kind: 'slot',
    targetBucketKey,
    dropIndex: preview.dropIndex,
    dropIndicatorY: preview.dropIndicatorY
  }
}

export function refreshProjectGroupHeaderDragSessionRects(
  container: HTMLElement | null,
  session: ProjectGroupHeaderDragSession | null
): void {
  if (!container || !session) {
    return
  }
  session.headerRects = measureProjectGroupHeaderDragRects(container)
  session.rootHeaderRects = session.rootProjectHeaderKeys
    ? measureRootProjectHeaderDragRects(
        container,
        session.rootProjectHeaderKeys,
        session.rootProjectHeaderHostId
      ).map((rect) => ({
        ...rect,
        groupId: rect.key,
        bucketKey: ROOT_INTERLEAVED_GROUP_BUCKET_KEY
      }))
    : undefined
  session.hostHeaderRects = readHostHeaderRects(container)
}

export function toProjectGroupDragState(
  groupId: string,
  catalogHostId: ExecutionHostId | null,
  dropTarget: ProjectGroupHeaderDropTarget | null
): ProjectGroupDragState {
  return {
    draggingGroupId: groupId,
    dropIndex: dropTarget?.kind === 'slot' ? dropTarget.dropIndex : null,
    dropIndicatorY: dropTarget?.kind === 'slot' ? dropTarget.dropIndicatorY : null,
    dropTargetGroupId: dropTarget?.kind === 'group-header' ? dropTarget.groupId : null,
    dropTargetCatalogHostId: dropTarget?.kind === 'group-header' ? catalogHostId : null
  }
}
