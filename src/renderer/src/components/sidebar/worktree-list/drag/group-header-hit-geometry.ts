import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  getRuntimeTargetHostId,
  ipcOrRuntimeTargetForHostId
} from '@/runtime/rpc/targets/runtime-client-target'
import type { HostHeaderRect } from './host-header-drag-dom'
import type { ProjectGroupHeaderDragRect } from './project-group-header-drop'

const GROUP_HEADER_GUTTER_RATIO = 0.2
const GROUP_HEADER_MAX_GUTTER_PX = 6

export function getCatalogHostIdForExecutionHost(
  hostId: ExecutionHostId | undefined
): ExecutionHostId | null {
  if (!hostId) {
    return null
  }
  const target = ipcOrRuntimeTargetForHostId(hostId)
  return target ? getRuntimeTargetHostId(target) : null
}

export function getGroupHeaderGutter(
  rect: Pick<ProjectGroupHeaderDragRect, 'top' | 'bottom'>
): number {
  const height = rect.bottom - rect.top
  if (height <= 0) {
    return 0
  }
  return Math.min(height * GROUP_HEADER_GUTTER_RATIO, GROUP_HEADER_MAX_GUTTER_PX)
}

export function isGroupHeaderBandHit(
  localY: number,
  rect: Pick<ProjectGroupHeaderDragRect, 'top' | 'bottom'>
): boolean {
  if (rect.bottom <= rect.top) {
    return false
  }
  const gutter = getGroupHeaderGutter(rect)
  return localY >= rect.top + gutter && localY <= rect.bottom - gutter
}

export function resolveHostSectionBounds(
  dragHostId: ExecutionHostId | undefined,
  hostHeaderRects: readonly HostHeaderRect[] | undefined
): { top: number; bottom: number } | null {
  if (!dragHostId || !hostHeaderRects || hostHeaderRects.length === 0) {
    return null
  }
  const ownIndex = hostHeaderRects.findIndex((rect) => rect.hostId === dragHostId)
  if (ownIndex === -1) {
    return null
  }
  return {
    top: hostHeaderRects[ownIndex]!.bottom,
    bottom: hostHeaderRects[ownIndex + 1]?.top ?? Number.POSITIVE_INFINITY
  }
}

export function findInnermostEnclosingGroupRect(
  localY: number,
  groupHeaderRects: readonly ProjectGroupHeaderDragRect[],
  excludeGroupIds?: ReadonlySet<string>
): ProjectGroupHeaderDragRect | undefined {
  let enclosingGroup: ProjectGroupHeaderDragRect | undefined
  for (const groupRect of groupHeaderRects) {
    if (excludeGroupIds?.has(groupRect.groupId)) {
      continue
    }
    const sectionBottom = groupRect.sectionBottom ?? groupRect.bottom
    const interiorTop =
      sectionBottom > groupRect.bottom
        ? groupRect.bottom - getGroupHeaderGutter(groupRect)
        : groupRect.bottom
    if (localY >= interiorTop && localY <= sectionBottom) {
      if (!enclosingGroup || groupRect.top >= enclosingGroup.top) {
        enclosingGroup = groupRect
      }
    }
  }
  return enclosingGroup
}
