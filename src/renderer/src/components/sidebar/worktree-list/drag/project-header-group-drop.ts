import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { readHostHeaderRects, type HostHeaderRect } from './host-header-drag-dom'
import {
  findInnermostEnclosingGroupRect,
  getCatalogHostIdForExecutionHost,
  isGroupHeaderBandHit,
  resolveHostSectionBounds
} from './group-header-hit-geometry'
import {
  measureProjectGroupHeaderDragRects,
  type ProjectGroupHeaderDragRect
} from './project-group-header-drop'
import {
  ROOT_INTERLEAVED_PROJECT_BUCKET_KEY,
  type ProjectHeaderDragSession,
  type RepoDragState
} from './project-header-drag-contract'
import { measureRootProjectHeaderDragRects } from './root-project-header-drop'
import {
  computeProjectHeaderDropPreview,
  measureProjectHeaderDragRects,
  type ProjectHeaderDragBucketKey,
  type ProjectHeaderDragRect
} from './project-header-drop'
import {
  resolveEmptyGroupInteriorSlot,
  resolveSubgroupExitToParentSlot
} from './project-header-subgroup-exit-drop'

export { getCatalogHostIdForExecutionHost }

export type ProjectHeaderDropTarget =
  | { kind: 'group-header'; groupId: string }
  | {
      kind: 'slot'
      targetBucketKey: ProjectHeaderDragBucketKey
      dropIndex: number
      dropIndicatorY: number
    }

const EMPTY_ROOT_TAIL_SLOP_PX = 32
const EMPTY_ROOT_DROP_RANGE_PX = 96
const INDICATOR_GAP_PX = 4

export function parseGroupIdFromBucketKey(bucketKey: ProjectHeaderDragBucketKey): string | null {
  return bucketKey.startsWith('group:') ? bucketKey.slice('group:'.length) : null
}

export function getJoinableGroupIdsForRepo(
  repo: Repo,
  projectGroups: readonly ProjectGroup[]
): Set<string> {
  const catalogHostId = getCatalogHostIdForExecutionHost(getRepoExecutionHostId(repo))
  if (!catalogHostId) {
    return new Set()
  }
  const ids = new Set<string>()
  for (const group of projectGroups) {
    if (getCatalogHostIdForExecutionHost(getRepoExecutionHostId(group)) === catalogHostId) {
      ids.add(group.id)
    }
  }
  return ids
}

export function canRepoStartHeaderDrag(args: {
  repo: Repo
  allowSlotReorder: boolean
  bucketItemCount: number
  joinableGroupIds: ReadonlySet<string>
}): boolean {
  const currentGroupId = args.repo.projectGroupId ?? null
  if (currentGroupId !== null) {
    return true
  }
  if (args.joinableGroupIds.size > 0) {
    return true
  }
  return args.allowSlotReorder && args.bucketItemCount > 1
}

export function computeCombinedProjectHeaderDropTarget(args: {
  pointerY: number
  containerTop: number
  scrollTop: number
  dragHostId?: ExecutionHostId
  currentGroupId: string | null
  currentParentGroupId?: string | null
  allowSlotReorder: boolean
  joinableGroupIds: ReadonlySet<string>
  hostHeaderRects?: readonly HostHeaderRect[]
  groupHeaderRects: readonly ProjectGroupHeaderDragRect[]
  repoHeaderRects: readonly ProjectHeaderDragRect[]
  rootProjectHeaderKeys?: readonly string[]
  rootHeaderRects?: readonly ProjectHeaderDragRect[]
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<ProjectHeaderDragBucketKey, readonly string[]>
  contentBottom?: number
}): ProjectHeaderDropTarget | null {
  const localY = args.pointerY - args.containerTop + args.scrollTop
  const hasEmptyRootDropZone =
    args.currentGroupId !== null &&
    (args.sidebarRepoHeaderIdsByBucket.get('ungrouped')?.length ?? 0) === 0
  const tailAllowancePx = hasEmptyRootDropZone ? EMPTY_ROOT_DROP_RANGE_PX : EMPTY_ROOT_TAIL_SLOP_PX
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
    if (groupRect.groupId === args.currentGroupId) {
      return null
    }
    if (!args.joinableGroupIds.has(groupRect.groupId)) {
      return null
    }
    if (isGroupHeaderBandHit(localY, groupRect)) {
      return { kind: 'group-header', groupId: groupRect.groupId }
    }
  }

  const enclosingGroup = findInnermostEnclosingGroupRect(localY, args.groupHeaderRects)
  if (enclosingGroup && !args.joinableGroupIds.has(enclosingGroup.groupId)) {
    return null
  }

  const currentBucketKey: ProjectHeaderDragBucketKey = args.currentGroupId
    ? `group:${args.currentGroupId}`
    : 'ungrouped'
  const targetBucketKey: ProjectHeaderDragBucketKey = enclosingGroup
    ? `group:${enclosingGroup.groupId}`
    : 'ungrouped'
  const bucketHeaderIds = args.sidebarRepoHeaderIdsByBucket.get(targetBucketKey) ?? []
  const bucketRects = args.repoHeaderRects.filter((rect) => {
    if (rect.bucketKey !== targetBucketKey) {
      return false
    }
    if (!hostSectionBounds) {
      return true
    }
    return rect.top >= hostSectionBounds.top && rect.top < hostSectionBounds.bottom
  })

  if (!enclosingGroup) {
    const parentExitSlot = resolveSubgroupExitToParentSlot({
      localY,
      scrollTop: args.scrollTop,
      currentGroupId: args.currentGroupId,
      currentParentGroupId: args.currentParentGroupId,
      joinableGroupIds: args.joinableGroupIds,
      groupHeaderRects: args.groupHeaderRects,
      repoHeaderRects: args.repoHeaderRects,
      sidebarRepoHeaderIdsByBucket: args.sidebarRepoHeaderIdsByBucket,
      hostSectionBottom: hostSectionBounds?.bottom
    })
    if (parentExitSlot) {
      return parentExitSlot
    }
    if (
      args.allowSlotReorder &&
      args.currentGroupId === null &&
      args.rootProjectHeaderKeys &&
      args.rootHeaderRects
    ) {
      const rootPreview = computeProjectHeaderDropPreview({
        pointerY: args.pointerY,
        containerTop: args.containerTop,
        scrollTop: args.scrollTop,
        rects: args.rootHeaderRects,
        sidebarRepoHeaderIds: args.rootProjectHeaderKeys,
        contentBottom: args.contentBottom
      })
      if (!rootPreview) {
        return null
      }
      return {
        kind: 'slot',
        targetBucketKey: ROOT_INTERLEAVED_PROJECT_BUCKET_KEY,
        dropIndex: rootPreview.dropIndex,
        dropIndicatorY: rootPreview.dropIndicatorY
      }
    }
  }

  if (!args.allowSlotReorder && targetBucketKey === currentBucketKey) {
    return null
  }

  if (
    enclosingGroup &&
    (bucketHeaderIds.length === 0 || (hostSectionBounds !== null && bucketRects.length === 0))
  ) {
    return resolveEmptyGroupInteriorSlot({
      enclosingGroup,
      currentGroupId: args.currentGroupId,
      scrollTop: args.scrollTop
    })
  }

  if (
    targetBucketKey === 'ungrouped' &&
    (bucketHeaderIds.length === 0 || (hostSectionBounds !== null && bucketRects.length === 0))
  ) {
    if (args.currentGroupId === null) {
      return null
    }
    let maxGroupBottom = 0
    let joinableGroupCount = 0
    for (const groupRect of args.groupHeaderRects) {
      if (!args.joinableGroupIds.has(groupRect.groupId)) {
        continue
      }
      joinableGroupCount++
      maxGroupBottom = Math.max(maxGroupBottom, groupRect.sectionBottom ?? groupRect.bottom)
    }
    if (joinableGroupCount === 0) {
      return null
    }
    const maxEmptyRootY = Math.min(
      maxGroupBottom + EMPTY_ROOT_DROP_RANGE_PX,
      hostSectionBounds?.bottom ?? Number.POSITIVE_INFINITY
    )
    if (localY > maxGroupBottom && localY <= maxEmptyRootY) {
      return {
        kind: 'slot',
        targetBucketKey: 'ungrouped',
        dropIndex: 0,
        dropIndicatorY: Math.max(args.scrollTop, maxGroupBottom + INDICATOR_GAP_PX)
      }
    }
    return null
  }
  const preview = computeProjectHeaderDropPreview({
    pointerY: args.pointerY,
    containerTop: args.containerTop,
    scrollTop: args.scrollTop,
    rects: bucketRects,
    sidebarRepoHeaderIds: bucketHeaderIds,
    contentBottom: args.contentBottom
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

export function refreshProjectHeaderDragSessionRects(
  container: HTMLElement | null,
  session: ProjectHeaderDragSession | null
): void {
  if (!container || !session) {
    return
  }
  session.headerRects = measureProjectHeaderDragRects(container)
  session.rootHeaderRects = session.rootProjectHeaderKeys
    ? measureRootProjectHeaderDragRects(
        container,
        session.rootProjectHeaderKeys,
        session.rootProjectHeaderHostId
      ).map((rect) => ({
        ...rect,
        repoId: rect.key,
        bucketKey: ROOT_INTERLEAVED_PROJECT_BUCKET_KEY
      }))
    : undefined
  session.groupHeaderRects = measureProjectGroupHeaderDragRects(container)
  session.hostHeaderRects = readHostHeaderRects(container)
}

export function getSessionGroupRepo(session: ProjectHeaderDragSession): Repo | null {
  return session.groupRepo === undefined ? session.repo : session.groupRepo
}

export function toRepoDragState(
  session: ProjectHeaderDragSession,
  dropTarget: ProjectHeaderDropTarget | null
): RepoDragState {
  const groupRepo = getSessionGroupRepo(session)
  const catalogHostId =
    dropTarget?.kind === 'group-header' && groupRepo
      ? getCatalogHostIdForExecutionHost(getRepoExecutionHostId(groupRepo))
      : null
  return {
    draggingRepoId: session.repo.id,
    dropIndex: dropTarget?.kind === 'slot' ? dropTarget.dropIndex : null,
    dropIndicatorY: dropTarget?.kind === 'slot' ? dropTarget.dropIndicatorY : null,
    dropTargetGroupId: dropTarget?.kind === 'group-header' ? dropTarget.groupId : null,
    dropTargetCatalogHostId: catalogHostId
  }
}
