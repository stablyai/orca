import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  getHeaderDragRepo,
  isProjectHeaderRowPinned,
  type Row
} from '../../../../../../shared/sidebar-list/row-types'
import {
  computeProjectHeaderDropPreview,
  type ProjectHeaderDragBucketKey,
  type ProjectHeaderDragRect
} from './project-header-drop'
import type { ProjectHeaderDropTarget } from './project-header-group-drop'

const PIN_TIER_EDGE_ZONE_PX = 56
const INDICATOR_GAP_PX = 4

export type PinTierFilterableRect = {
  headerIndex: number
  top: number
  bottom: number
  sectionBottom?: number
}

export function getSidebarPinnedRepoHeaderIds(rows: readonly Row[]): Set<string> {
  const pinnedIds = new Set<string>()
  for (const row of rows) {
    if (row.type !== 'header') {
      continue
    }
    const repo = getHeaderDragRepo(row)
    if (repo && isProjectHeaderRowPinned(row)) {
      pinnedIds.add(repo.id)
    }
  }
  return pinnedIds
}

export function isRepoHeaderIdPinned(
  repoId: string,
  pinnedRepoHeaderIds?: ReadonlySet<string>,
  repoById?: ReadonlyMap<string, Repo>
): boolean {
  if (pinnedRepoHeaderIds) {
    return pinnedRepoHeaderIds.has(repoId)
  }
  return repoById?.get(repoId)?.isPinned === true
}

export function filterRootProjectHeaderKeysByPinTier(args: {
  keys: readonly string[] | undefined
  isPinned: boolean
  projectGroupById?: ReadonlyMap<string, ProjectGroup>
  pinnedRepoHeaderIds?: ReadonlySet<string>
  repoById?: ReadonlyMap<string, Repo>
}): readonly string[] | undefined {
  if (!args.keys) {
    return undefined
  }
  return args.keys.filter((key) => {
    if (key.startsWith('group:')) {
      const groupPinned = args.projectGroupById?.get(key.slice('group:'.length))?.isPinned === true
      return groupPinned === args.isPinned
    }
    if (key.startsWith('repo:')) {
      const repoPinned = isRepoHeaderIdPinned(
        key.slice('repo:'.length),
        args.pinnedRepoHeaderIds,
        args.repoById
      )
      return repoPinned === args.isPinned
    }
    return false
  })
}

export function reindexBucketRectsByHeaderIds<
  TRect extends PinTierFilterableRect,
  TId extends string = string
>(allHeaderIds: readonly TId[], allRects: readonly TRect[], getId: (rect: TRect) => TId): TRect[] {
  const indexById = new Map(allHeaderIds.map((id, index) => [id, index]))
  return allRects
    .filter((rect) => indexById.has(getId(rect)))
    .map((rect) => ({
      ...rect,
      headerIndex: indexById.get(getId(rect)) ?? rect.headerIndex
    }))
}

export function filterBucketByPinTier<
  TRect extends PinTierFilterableRect,
  TId extends string = string
>(args: {
  allHeaderIds: readonly TId[]
  allRects: readonly TRect[]
  getId: (rect: TRect) => TId
  isIdPinned: (id: TId) => boolean
  targetPinned: boolean
}): { tierHeaderIds: TId[]; tierRects: TRect[] } {
  const tierHeaderIds = args.allHeaderIds.filter((id) => args.isIdPinned(id) === args.targetPinned)
  return {
    tierHeaderIds,
    tierRects: reindexBucketRectsByHeaderIds(tierHeaderIds, args.allRects, args.getId)
  }
}

export function resolveCrossBucketPinnedPrefixSlot<TRect extends PinTierFilterableRect>(args: {
  localY: number
  scrollTop: number
  contentBottom?: number
  enclosingGroupBottom?: number
  allBucketHeaderCount: number
  allBucketRects: readonly TRect[]
  tierHeaderCount: number
  tierRects: readonly TRect[]
}): { dropIndex: number; dropIndicatorY: number } | null {
  if (args.contentBottom !== undefined && args.localY > args.contentBottom) {
    return null
  }
  if (args.allBucketHeaderCount > 0 && args.tierHeaderCount === 0) {
    if (args.allBucketRects.length === 0) {
      return null
    }
    const firstPinned = args.allBucketRects[0]!
    const lastPinned = args.allBucketRects.at(-1)!
    // Wait until the last pinned header in the bucket is mounted so we never draw mid-tier.
    if (lastPinned.headerIndex !== args.allBucketHeaderCount - 1) {
      return null
    }
    const lastPinnedBottom = Math.max(
      lastPinned.bottom,
      lastPinned.sectionBottom ?? lastPinned.bottom
    )
    if (
      args.enclosingGroupBottom === undefined &&
      (args.localY < firstPinned.top - PIN_TIER_EDGE_ZONE_PX ||
        args.localY > lastPinnedBottom + PIN_TIER_EDGE_ZONE_PX)
    ) {
      return null
    }
    return {
      dropIndex: 0,
      dropIndicatorY: Math.max(args.scrollTop, lastPinnedBottom + INDICATOR_GAP_PX)
    }
  }
  const pinnedPrefixTop =
    args.enclosingGroupBottom ??
    (args.allBucketRects.length > 0
      ? args.allBucketRects[0]!.top - PIN_TIER_EDGE_ZONE_PX
      : undefined)
  if (
    pinnedPrefixTop !== undefined &&
    args.tierRects.length > 0 &&
    args.localY >= pinnedPrefixTop &&
    args.localY < args.tierRects[0]!.top
  ) {
    return {
      dropIndex: 0,
      dropIndicatorY: Math.max(
        args.scrollTop,
        Math.max(0, args.tierRects[0]!.top - INDICATOR_GAP_PX)
      )
    }
  }
  return null
}

export function resolveRepoOnlyBucketSlot(args: {
  pointerY: number
  containerTop: number
  scrollTop: number
  localY: number
  targetBucketKey: ProjectHeaderDragBucketKey
  isCrossBucket: boolean
  draggedRepoPinned?: boolean
  pinnedRepoHeaderIds?: ReadonlySet<string>
  repoById?: ReadonlyMap<string, Repo>
  enclosingGroupBottom?: number
  allBucketHeaderIds: readonly string[]
  allBucketRects: readonly ProjectHeaderDragRect[]
  contentBottom?: number
}): ProjectHeaderDropTarget | null {
  const hostBucketRects = reindexBucketRectsByHeaderIds(
    args.allBucketHeaderIds,
    args.allBucketRects,
    (rect) => rect.repoId
  )
  const hasPinFilter =
    args.pinnedRepoHeaderIds !== undefined ||
    args.repoById !== undefined ||
    args.draggedRepoPinned !== undefined
  const { tierHeaderIds: bucketHeaderIds, tierRects: bucketRects } = hasPinFilter
    ? filterBucketByPinTier({
        allHeaderIds: args.allBucketHeaderIds,
        allRects: hostBucketRects,
        getId: (rect) => rect.repoId,
        isIdPinned: (id) => isRepoHeaderIdPinned(id, args.pinnedRepoHeaderIds, args.repoById),
        targetPinned: args.isCrossBucket ? false : Boolean(args.draggedRepoPinned)
      })
    : { tierHeaderIds: [...args.allBucketHeaderIds], tierRects: hostBucketRects }

  if (args.isCrossBucket && bucketHeaderIds.length === 0) {
    const pinnedOnlySlot = resolveCrossBucketPinnedPrefixSlot({
      localY: args.localY,
      scrollTop: args.scrollTop,
      contentBottom: args.contentBottom,
      enclosingGroupBottom: args.enclosingGroupBottom,
      allBucketHeaderCount: args.allBucketHeaderIds.length,
      allBucketRects: hostBucketRects,
      tierHeaderCount: 0,
      tierRects: bucketRects
    })
    return pinnedOnlySlot
      ? { kind: 'slot', targetBucketKey: args.targetBucketKey, ...pinnedOnlySlot }
      : null
  }

  const preview =
    computeProjectHeaderDropPreview({
      pointerY: args.pointerY,
      containerTop: args.containerTop,
      scrollTop: args.scrollTop,
      rects: bucketRects,
      sidebarRepoHeaderIds: bucketHeaderIds,
      contentBottom: args.contentBottom
    }) ??
    (args.isCrossBucket
      ? resolveCrossBucketPinnedPrefixSlot({
          localY: args.localY,
          scrollTop: args.scrollTop,
          contentBottom: args.contentBottom,
          enclosingGroupBottom: args.enclosingGroupBottom,
          allBucketHeaderCount: args.allBucketHeaderIds.length,
          allBucketRects: hostBucketRects,
          tierHeaderCount: bucketHeaderIds.length,
          tierRects: bucketRects
        })
      : null)
  return preview ? { kind: 'slot', targetBucketKey: args.targetBucketKey, ...preview } : null
}
