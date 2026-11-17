import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import {
  compareCodePoints,
  compareSidebarText
} from '../../../../../../shared/sidebar-list/sorting/text-order'
import {
  getRuntimeTargetHostId,
  ipcOrRuntimeTargetForHostId
} from '@/runtime/rpc/targets/runtime-client-target'
import { isSameRepoRow } from '@/store/repos/repo-host-identity'
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

export function filterProjectGroupIdsByExactOwnerHost(
  groupIds: readonly string[],
  ownerHostId: ExecutionHostId | null | undefined,
  projectGroupById: ReadonlyMap<string, ProjectGroup>
): string[] {
  if (!ownerHostId) {
    return [...groupIds]
  }
  return groupIds.filter((groupId) => {
    const candidate = projectGroupById.get(groupId)
    return !candidate || getRepoExecutionHostId(candidate) === ownerHostId
  })
}

function isParentPresentForOwner(
  projectGroupById: ReadonlyMap<string, ProjectGroup>,
  parentGroupId: string,
  ownerHostId: ExecutionHostId | null | undefined
): boolean {
  const parent = projectGroupById.get(parentGroupId)
  return Boolean(parent && (!ownerHostId || getRepoExecutionHostId(parent) === ownerHostId))
}

function compareProjectGroupsInBucket(left: ProjectGroup, right: ProjectGroup): number {
  return (
    (right.isPinned ? 1 : 0) - (left.isPinned ? 1 : 0) ||
    left.tabOrder - right.tabOrder ||
    compareSidebarText(left.name, right.name) ||
    compareCodePoints(left.id, right.id)
  )
}

export function collectTargetProjectGroupSiblingIds(args: {
  draggedGroupId: string
  targetParentGroupId: string | null
  ownerHostId: ExecutionHostId | null | undefined
  seededSiblingIds: readonly string[]
  projectGroupById: ReadonlyMap<string, ProjectGroup>
}): string[] {
  const result = filterProjectGroupIdsByExactOwnerHost(
    args.seededSiblingIds,
    args.ownerHostId,
    args.projectGroupById
  ).filter((groupId) => groupId !== args.draggedGroupId)
  const seen = new Set(result)
  const hiddenSiblings = filterProjectGroupIdsByExactOwnerHost(
    [...args.projectGroupById.values()]
      .filter((candidate) => {
        if (candidate.id === args.draggedGroupId || seen.has(candidate.id)) {
          return false
        }
        return args.targetParentGroupId !== null
          ? candidate.parentGroupId === args.targetParentGroupId
          : !candidate.parentGroupId ||
              !isParentPresentForOwner(
                args.projectGroupById,
                candidate.parentGroupId,
                args.ownerHostId
              )
      })
      .sort(compareProjectGroupsInBucket)
      .map((candidate) => candidate.id),
    args.ownerHostId,
    args.projectGroupById
  )
  const combined = [...result, ...hiddenSiblings]
  if (args.targetParentGroupId === null) {
    return combined
  }
  const seededIndexById = new Map(result.map((id, index) => [id, index]))
  return combined.sort((leftId, rightId) => {
    const left = args.projectGroupById.get(leftId)
    const right = args.projectGroupById.get(rightId)
    if (left && right) {
      return compareProjectGroupsInBucket(left, right)
    }
    const leftSeededIndex = seededIndexById.get(leftId)
    const rightSeededIndex = seededIndexById.get(rightId)
    if (leftSeededIndex !== undefined && rightSeededIndex !== undefined) {
      return leftSeededIndex - rightSeededIndex
    }
    if (leftSeededIndex !== undefined) {
      return -1
    }
    if (rightSeededIndex !== undefined) {
      return 1
    }
    return compareCodePoints(leftId, rightId)
  })
}

export function isProjectGroupStillInExpectedParent(args: {
  groupId: string
  expectedParentGroupId: string | null
  ownerHostId: ExecutionHostId | null | undefined
  liveProjectGroups: readonly ProjectGroup[] | undefined
  fallbackProjectGroupById: ReadonlyMap<string, ProjectGroup>
}): boolean {
  if (args.liveProjectGroups) {
    const sameHostGroups = args.ownerHostId
      ? args.liveProjectGroups.filter(
          (candidate) => getRepoExecutionHostId(candidate) === args.ownerHostId
        )
      : args.liveProjectGroups
    const target = sameHostGroups.find((candidate) => candidate.id === args.groupId)
    if (!target) {
      return false
    }
    const sameHostIds = new Set(sameHostGroups.map((candidate) => candidate.id))
    const effectiveParentId =
      target.parentGroupId && sameHostIds.has(target.parentGroupId) ? target.parentGroupId : null
    return effectiveParentId === args.expectedParentGroupId
  }
  const target = args.fallbackProjectGroupById.get(args.groupId)
  if (!target || (args.ownerHostId && getRepoExecutionHostId(target) !== args.ownerHostId)) {
    return false
  }
  const effectiveParentId =
    target.parentGroupId &&
    isParentPresentForOwner(args.fallbackProjectGroupById, target.parentGroupId, args.ownerHostId)
      ? target.parentGroupId
      : null
  return effectiveParentId === args.expectedParentGroupId
}

export function isRepoStillInExpectedProjectGroup(args: {
  repo: Repo
  expectedProjectGroupId: string | null
  liveRepos: readonly Repo[] | undefined
  fallbackRepoById: ReadonlyMap<string, Repo> | undefined
}): boolean {
  if (args.liveRepos) {
    const liveMatch = args.liveRepos.find((candidate) => isSameRepoRow(candidate, args.repo))
    return (
      liveMatch !== undefined && (liveMatch.projectGroupId ?? null) === args.expectedProjectGroupId
    )
  }
  const fallback = args.fallbackRepoById?.get(args.repo.id)
  const target = fallback && isSameRepoRow(fallback, args.repo) ? fallback : args.repo
  return (target.projectGroupId ?? null) === args.expectedProjectGroupId
}
