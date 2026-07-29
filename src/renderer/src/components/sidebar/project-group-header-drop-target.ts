import {
  computeProjectGroupHeaderDropPreview,
  getParentGroupIdForHeaderDragBucketKey,
  ROOT_PROJECT_GROUP_HEADER_BUCKET,
  type ProjectGroupHeaderDragBucketKey,
  type ProjectGroupHeaderDragRect
} from './project-group-header-drop'
import type {
  ProjectGroupDragState,
  ProjectGroupHeaderDragSession
} from './project-group-header-drag-contract'
import type { ProjectGroupReparentValidator } from '../../../../shared/project-group-reparent'

export type ProjectGroupHeaderDropTarget =
  | {
      kind: 'reorder'
      bucketKey: ProjectGroupHeaderDragBucketKey
      dropIndex: number
      dropIndicatorY: number
    }
  | { kind: 'nest'; targetGroupId: string }

// Middle share of a hovered header that nests the dragged group into it; the
// remaining top/bottom quarters keep the sibling reorder gesture.
const NEST_ZONE_RATIO = 0.5

export type ComputeProjectGroupHeaderDropTargetArgs = {
  pointerY: number
  containerTop: number
  scrollTop: number
  contentBottom?: number
  rects: readonly ProjectGroupHeaderDragRect[]
  draggedGroupId: string
  sourceBucketKey: ProjectGroupHeaderDragBucketKey
  sourceParentGroupId: string | null
  draggedSubtreeGroupIds: ReadonlySet<string>
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
    ProjectGroupHeaderDragBucketKey,
    readonly string[]
  >
  validateReparent: ProjectGroupReparentValidator
}

export function getProjectGroupDragStateForDropTarget(
  draggingGroupId: string,
  dropTarget: ProjectGroupHeaderDropTarget | null
): ProjectGroupDragState {
  if (dropTarget === null) {
    return { draggingGroupId, dropIndex: null, dropIndicatorY: null, nestTargetGroupId: null }
  }
  if (dropTarget.kind === 'nest') {
    return {
      draggingGroupId,
      dropIndex: null,
      dropIndicatorY: null,
      nestTargetGroupId: dropTarget.targetGroupId
    }
  }
  return {
    draggingGroupId,
    dropIndex: dropTarget.dropIndex,
    dropIndicatorY: dropTarget.dropIndicatorY,
    nestTargetGroupId: null
  }
}

export function computeProjectGroupHeaderDropTargetForSession(args: {
  pointerY: number
  container: HTMLElement
  session: Pick<
    ProjectGroupHeaderDragSession,
    | 'groupId'
    | 'bucketKey'
    | 'sourceParentGroupId'
    | 'reparentIndex'
    | 'sidebarProjectGroupHeaderIdsByBucket'
    | 'headerRects'
  >
}): ProjectGroupHeaderDropTarget | null {
  if (!args.session.reparentIndex) {
    return null
  }
  const containerRect = args.container.getBoundingClientRect()
  return computeProjectGroupHeaderDropTarget({
    pointerY: args.pointerY,
    containerTop: containerRect.top,
    scrollTop: args.container.scrollTop,
    contentBottom: args.container.scrollHeight,
    rects: args.session.headerRects,
    draggedGroupId: args.session.groupId,
    sourceBucketKey: args.session.bucketKey,
    sourceParentGroupId: args.session.sourceParentGroupId,
    draggedSubtreeGroupIds: args.session.reparentIndex.subtreeIds,
    sidebarProjectGroupHeaderIdsByBucket: args.session.sidebarProjectGroupHeaderIdsByBucket,
    validateReparent: args.session.reparentIndex.validate
  })
}

export function computeProjectGroupHeaderDropTarget(
  args: ComputeProjectGroupHeaderDropTargetArgs
): ProjectGroupHeaderDropTarget | null {
  const localY = args.pointerY - args.containerTop + args.scrollTop
  const hoveredRect = args.rects.find((rect) => localY >= rect.top && localY <= rect.bottom)

  if (hoveredRect) {
    if (args.draggedSubtreeGroupIds.has(hoveredRect.groupId)) {
      // Why: the dragged header itself still anchors same-bucket reorder, but
      // its descendants are dead zones — a subtree cannot land inside itself.
      return hoveredRect.groupId === args.draggedGroupId
        ? computeBucketReorderDropTarget(args, args.sourceBucketKey)
        : null
    }
    const height = hoveredRect.bottom - hoveredRect.top
    const nestPad = (height * (1 - NEST_ZONE_RATIO)) / 2
    const inNestZone = localY >= hoveredRect.top + nestPad && localY <= hoveredRect.bottom - nestPad
    if (
      inNestZone &&
      hoveredRect.groupId !== args.sourceParentGroupId &&
      args.validateReparent(hoveredRect.groupId) === null
    ) {
      return { kind: 'nest', targetGroupId: hoveredRect.groupId }
    }
    return computeBucketReorderDropTarget(args, hoveredRect.bucketKey)
  }

  // Gaps and list edges: keep today's source-bucket boundary behavior first,
  // then fall back to the root bucket so nested groups can un-nest by
  // dragging past the top or bottom of the list.
  const sourceBucketDrop = computeBucketReorderDropTarget(args, args.sourceBucketKey)
  if (sourceBucketDrop || args.sourceBucketKey === ROOT_PROJECT_GROUP_HEADER_BUCKET) {
    return sourceBucketDrop
  }
  return computeBucketReorderDropTarget(args, ROOT_PROJECT_GROUP_HEADER_BUCKET)
}

function computeBucketReorderDropTarget(
  args: ComputeProjectGroupHeaderDropTargetArgs,
  bucketKey: ProjectGroupHeaderDragBucketKey
): ProjectGroupHeaderDropTarget | null {
  // Why: landing between the headers of a foreign bucket reparents to that
  // bucket's parent, so it must clear the same cycle/depth validation as an
  // explicit nest drop.
  if (
    bucketKey !== args.sourceBucketKey &&
    args.validateReparent(getParentGroupIdForHeaderDragBucketKey(bucketKey)) !== null
  ) {
    return null
  }
  const preview = computeProjectGroupHeaderDropPreview({
    pointerY: args.pointerY,
    containerTop: args.containerTop,
    scrollTop: args.scrollTop,
    contentBottom: args.contentBottom,
    rects: args.rects.filter((rect) => rect.bucketKey === bucketKey),
    sidebarProjectGroupHeaderIds: args.sidebarProjectGroupHeaderIdsByBucket.get(bucketKey) ?? []
  })
  return preview ? { kind: 'reorder', bucketKey, ...preview } : null
}
