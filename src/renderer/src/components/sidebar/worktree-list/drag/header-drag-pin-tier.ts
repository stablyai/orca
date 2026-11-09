import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import {
  getHeaderDragRepo,
  isProjectHeaderRowPinned,
  type Row
} from '../../../../../../shared/sidebar-list/row-types'
import { getCatalogHostIdForExecutionHost } from './group-header-hit-geometry'

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
    if (!repo) {
      continue
    }
    const hostId = row.hostId ?? getRepoExecutionHostId(row.repo ?? repo)
    const isRowPinned = isProjectHeaderRowPinned(row)
    const addKey = (id: string): void => {
      pinnedIds.add(`scoped::${id}`)
      pinnedIds.add(`hostSeen::${hostId}::${id}`)
      if (isRowPinned) {
        pinnedIds.add(id)
        pinnedIds.add(`host::${hostId}::${id}`)
      }
    }
    addKey(repo.id)
    if (row.repo && row.repo.id !== repo.id) {
      addKey(row.repo.id)
    }
  }
  return pinnedIds
}

export function isRepoHeaderIdPinned(
  repoId: string,
  pinnedRepoHeaderIds?: ReadonlySet<string>,
  repoById?: ReadonlyMap<string, Repo>,
  ownerHostId?: ExecutionHostId | null,
  liveRepos?: readonly Repo[]
): boolean {
  if (ownerHostId && pinnedRepoHeaderIds?.has(`host::${ownerHostId}::${repoId}`)) {
    return true
  }
  if (ownerHostId && pinnedRepoHeaderIds?.has(`hostSeen::${ownerHostId}::${repoId}`)) {
    return false
  }
  const catalogHostId = getCatalogHostIdForExecutionHost(ownerHostId ?? undefined)
  const matchesTargetScope = (candidateHostId: ExecutionHostId): boolean => {
    if (!ownerHostId) {
      return false
    }
    return ownerHostId === catalogHostId
      ? getCatalogHostIdForExecutionHost(candidateHostId) === catalogHostId
      : candidateHostId === ownerHostId
  }
  let hasScopedLiveMatches = false
  if (ownerHostId && liveRepos) {
    const scopedMatches = liveRepos.filter(
      (repo) => repo.id === repoId && matchesTargetScope(getRepoExecutionHostId(repo))
    )
    hasScopedLiveMatches = scopedMatches.length > 0
    if (scopedMatches.some((repo) => repo.isPinned === true)) {
      return true
    }
    const hasPinnedOutsideScope = liveRepos.some(
      (repo) =>
        repo.id === repoId &&
        !matchesTargetScope(getRepoExecutionHostId(repo)) &&
        repo.isPinned === true
    )
    if (
      hasScopedLiveMatches &&
      (!pinnedRepoHeaderIds ||
        hasPinnedOutsideScope ||
        pinnedRepoHeaderIds.has(`scoped::${repoId}`))
    ) {
      return false
    }
  }
  if (!hasScopedLiveMatches) {
    const candidate = repoById?.get(repoId)
    if (
      candidate &&
      (!ownerHostId || matchesTargetScope(getRepoExecutionHostId(candidate))) &&
      candidate.isPinned === true
    ) {
      return true
    }
  }
  if (pinnedRepoHeaderIds) {
    if (ownerHostId && pinnedRepoHeaderIds.has(`scoped::${repoId}`)) {
      return false
    }
    return pinnedRepoHeaderIds.has(repoId)
  }
  return false
}

export function filterRootProjectHeaderKeysByPinTier(args: {
  keys: readonly string[] | undefined
  isPinned: boolean
  projectGroupById?: ReadonlyMap<string, ProjectGroup>
  pinnedRepoHeaderIds?: ReadonlySet<string>
  repoById?: ReadonlyMap<string, Repo>
  ownerHostId?: ExecutionHostId | null
  liveRepos?: readonly Repo[]
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
        args.repoById,
        args.ownerHostId,
        args.liveRepos
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
      dropIndex: args.tierRects[0]!.headerIndex,
      dropIndicatorY: Math.max(
        args.scrollTop,
        Math.max(0, args.tierRects[0]!.top - INDICATOR_GAP_PX)
      )
    }
  }
  return null
}
