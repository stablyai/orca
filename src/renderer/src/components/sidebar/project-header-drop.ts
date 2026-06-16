import { getWorktreeSidebarBoundaryDrop } from './worktree-sidebar-drag-autoscroll'
import type { Row } from './worktree-list-groups'
import type { Repo } from '../../../../shared/types'

export type ProjectHeaderDragBucketKey = string

export type ProjectHeaderDragRect = {
  repoId: string
  bucketKey: ProjectHeaderDragBucketKey
  // Index among sibling repo headers in the drag bucket (from the row model),
  // not the mounted subset. Virtualized rows unmount off-screen headers, so
  // loop index over mounted rects would map drops to the wrong persisted order.
  headerIndex: number
  top: number
  bottom: number
}

export type ProjectHeaderDropPreview = {
  dropIndex: number
  dropIndicatorY: number
}

const INDICATOR_GAP_PX = 4

export function getProjectHeaderDragBucketKey(
  repo: Pick<Repo, 'projectGroupId'>
): ProjectHeaderDragBucketKey {
  return repo.projectGroupId ? `group:${repo.projectGroupId}` : 'ungrouped'
}

export function getSidebarOrderedRepoHeaderIds(rows: readonly Row[]): string[] {
  const ids: string[] = []
  for (const row of rows) {
    if (row.type === 'header' && row.repo) {
      ids.push(row.repo.id)
    }
  }
  return ids
}

export function getSidebarOrderedRepoHeaderIdsByBucket(
  rows: readonly Row[]
): Map<ProjectHeaderDragBucketKey, string[]> {
  const buckets = new Map<ProjectHeaderDragBucketKey, string[]>()
  for (const row of rows) {
    if (row.type !== 'header' || !row.repo) {
      continue
    }
    const bucketKey = getProjectHeaderDragBucketKey(row.repo)
    const list = buckets.get(bucketKey) ?? []
    list.push(row.repo.id)
    buckets.set(bucketKey, list)
  }
  return buckets
}

export function getProjectGroupOrderForSidebarDrop(args: {
  siblings: readonly Repo[]
  dropIndex: number
  repoOrderRankById?: ReadonlyMap<string, number>
}): number {
  const ordered = args.siblings.slice()
  if (ordered.length === 0) {
    return 0
  }
  const getEffectiveOrder = (repo: Repo | undefined, fallbackIndex: number): number | undefined => {
    if (!repo) {
      return undefined
    }
    const order = repo.projectGroupOrder
    if (typeof order === 'number' && Number.isFinite(order)) {
      return order
    }
    const repoRank = args.repoOrderRankById?.get(repo.id)
    return (repoRank ?? fallbackIndex) * 1000
  }
  const before = getEffectiveOrder(ordered[args.dropIndex - 1], args.dropIndex - 1)
  const after = getEffectiveOrder(ordered[args.dropIndex], args.dropIndex)
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
    return before + (after - before) / 2
  }
  // Why: duplicate legacy ranks leave no numeric slot between neighbors; choose
  // a deterministic finite value so the next drag has a persisted anchor.
  return before + 1
}

export function mapSidebarProjectHeaderDropIndexToSiblingInsertIndex(args: {
  sidebarDropIndex: number
  sourceIndex: number
  siblingCount: number
}): number {
  // Why: sidebar drop indices include the dragged header, but group-order ranks
  // are computed against the sibling list after that header is removed.
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

export function measureProjectHeaderDragRects(
  container: HTMLElement,
  bucketKey?: ProjectHeaderDragBucketKey
): ProjectHeaderDragRect[] {
  const containerRect = container.getBoundingClientRect()
  const rects: ProjectHeaderDragRect[] = []
  container.querySelectorAll<HTMLElement>('[data-repo-header-id]').forEach((element) => {
    const repoId = element.getAttribute('data-repo-header-id')
    const elementBucketKey = element.getAttribute('data-repo-header-bucket')
    const rawHeaderIndex = element.getAttribute('data-repo-header-index')
    const headerIndex = rawHeaderIndex === null ? Number.NaN : Number(rawHeaderIndex)
    if (!repoId || !elementBucketKey || !Number.isFinite(headerIndex)) {
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
      repoId,
      bucketKey: elementBucketKey,
      headerIndex,
      top,
      bottom: top + rect.height
    })
  })
  rects.sort((left, right) => left.top - right.top)
  return rects
}

export function mapSidebarRepoDropIndexToAllRepoInsertAt(
  sidebarDropIndex: number,
  sidebarRepoHeaderIds: readonly string[],
  allRepoIds: readonly string[]
): number {
  if (sidebarRepoHeaderIds.length === 0) {
    return 0
  }
  if (sidebarDropIndex <= 0) {
    return allRepoIds.indexOf(sidebarRepoHeaderIds[0]!)
  }
  if (sidebarDropIndex >= sidebarRepoHeaderIds.length) {
    const lastId = sidebarRepoHeaderIds.at(-1)!
    return allRepoIds.indexOf(lastId) + 1
  }
  return allRepoIds.indexOf(sidebarRepoHeaderIds[sidebarDropIndex]!)
}

export function computeProjectHeaderDropPreview(args: {
  pointerY: number
  containerTop: number
  scrollTop: number
  rects: readonly ProjectHeaderDragRect[]
  sidebarRepoHeaderIds: readonly string[]
}): ProjectHeaderDropPreview | null {
  const { rects, sidebarRepoHeaderIds } = args
  if (rects.length === 0 || sidebarRepoHeaderIds.length === 0) {
    return null
  }

  const localY = args.pointerY - args.containerTop + args.scrollTop
  const first = rects[0]!
  const last = rects.at(-1)!
  const boundaryDrop = getWorktreeSidebarBoundaryDrop({
    localY,
    firstRect: {
      worktreeId: first.repoId,
      groupIndex: first.headerIndex,
      top: first.top,
      bottom: first.bottom
    },
    lastRect: {
      worktreeId: last.repoId,
      groupIndex: last.headerIndex,
      top: last.top,
      bottom: last.bottom
    },
    sourceGroupSize: sidebarRepoHeaderIds.length
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

export function applyAllRepoInsertAt(
  allRepoIds: readonly string[],
  draggedRepoId: string,
  insertAt: number
): string[] | null {
  const fromIndex = allRepoIds.indexOf(draggedRepoId)
  if (fromIndex === -1 || insertAt < 0 || insertAt > allRepoIds.length) {
    return null
  }
  const next = allRepoIds.slice()
  next.splice(fromIndex, 1)
  const adjustedInsertAt = insertAt > fromIndex ? insertAt - 1 : insertAt
  if (adjustedInsertAt === fromIndex) {
    return null
  }
  next.splice(adjustedInsertAt, 0, draggedRepoId)
  return next
}
