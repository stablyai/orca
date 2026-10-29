import { estimateRenderRowSize } from './worktree-list/viewport/virtual-rows'
import type { RenderRow } from './worktree-list/listing/render-row'
import type { GroupHeaderRow } from '../../../../shared/sidebar-list/row-types'
import type { SidebarRootSlot } from './sidebar-root-slot-order'

function getEstimatedRenderRowStarts(
  rows: readonly RenderRow[],
  firstHeaderIndex: number
): number[] {
  const starts: number[] = []
  let offset = 0
  for (let index = 0; index < rows.length; index++) {
    starts[index] = offset
    offset += estimateRenderRowSize(rows, index, firstHeaderIndex, null)
  }
  starts[rows.length] = offset
  return starts
}

// Index once to avoid O(headers × rows) rebuilds on agent ticks; preserve findIndex’s first-match behavior.
function indexHeaderRenderRows(
  rows: readonly RenderRow[],
  keyOf: (row: GroupHeaderRow) => string | null | undefined
): Map<string, number> {
  const indexByKey = new Map<string, number>()
  rows.forEach((row, index) => {
    const key = row.type === 'header' ? keyOf(row) : undefined
    if (typeof key === 'string' && !indexByKey.has(key)) {
      indexByKey.set(key, index)
    }
  })
  return indexByKey
}

// Index successors per bucket; duplicate IDs retain each bucket’s first occurrence, matching indexOf.
function indexBucketSuccessors(
  idsByBucket: ReadonlyMap<string, readonly string[]>
): Map<string, ReadonlyMap<string, string | undefined>> {
  const successorsByBucket = new Map<string, ReadonlyMap<string, string | undefined>>()
  for (const [bucketKey, ids] of idsByBucket) {
    const successorById = new Map<string, string | undefined>()
    ids.forEach((id, index) => {
      if (!successorById.has(id)) {
        successorById.set(id, ids[index + 1])
      }
    })
    successorsByBucket.set(bucketKey, successorById)
  }
  return successorsByBucket
}

function findNextHeaderRenderRowIndex(rows: readonly RenderRow[], startIndex: number): number {
  for (let index = startIndex; index < rows.length; index++) {
    const row = rows[index]
    if (row?.type === 'header' || row?.type === 'host-header') {
      return index
    }
  }
  return rows.length
}

function nextRootSlotRowIndex(args: {
  rows: readonly RenderRow[]
  sidebarRootSlots: readonly SidebarRootSlot[] | undefined
  slot: SidebarRootSlot
  repoHeaderIndexByRepoId: ReadonlyMap<string, number>
  projectGroupHeaderIndexByGroupId: ReadonlyMap<string, number>
  fallbackStartIndex: number
  depth: number
  preferProjectGroupSectionEnd: boolean
}): number {
  const slots = args.sidebarRootSlots
  if (!slots || slots.length === 0) {
    return -1
  }
  const rootIndex = slots.findIndex(
    (candidate) => candidate.kind === args.slot.kind && candidate.id === args.slot.id
  )
  const nextSlot = rootIndex >= 0 ? slots[rootIndex + 1] : undefined
  if (nextSlot) {
    return nextSlot.kind === 'repo'
      ? (args.repoHeaderIndexByRepoId.get(nextSlot.id) ?? -1)
      : (args.projectGroupHeaderIndexByGroupId.get(nextSlot.id) ?? -1)
  }
  return args.preferProjectGroupSectionEnd
    ? findProjectGroupSectionEndIndex(args.rows, args.fallbackStartIndex, args.depth)
    : findNextHeaderRenderRowIndex(args.rows, args.fallbackStartIndex)
}

function findProjectGroupSectionEndIndex(
  rows: readonly RenderRow[],
  startIndex: number,
  depth: number
): number {
  for (let index = startIndex; index < rows.length; index++) {
    const row = rows[index]
    if (!row) {
      continue
    }
    if (row.type === 'host-header') {
      return index
    }
    if (row.type !== 'header') {
      continue
    }
    const rowDepth = row.projectGroupDepth ?? 0
    if (rowDepth <= depth || (!row.repo && !row.projectGroup)) {
      return index
    }
  }
  return rows.length
}

export function getRepoHeaderSectionEndByRepoId(args: {
  rows: readonly RenderRow[]
  firstHeaderIndex: number
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<string, readonly string[]>
  repoHeaderBucketByRepoId: ReadonlyMap<string, string>
  sidebarRootSlots?: readonly SidebarRootSlot[]
}): Map<string, number> {
  const rowStarts = getEstimatedRenderRowStarts(args.rows, args.firstHeaderIndex)
  const repoHeaderIndexByRepoId = indexHeaderRenderRows(args.rows, (row) => row.repo?.id)
  const projectGroupHeaderIndexByGroupId = indexHeaderRenderRows(args.rows, (row) =>
    row.repo ? undefined : row.projectGroup?.id
  )
  const repoSuccessorsByBucket = indexBucketSuccessors(args.sidebarRepoHeaderIdsByBucket)
  const sectionEndByRepoId = new Map<string, number>()
  for (let index = 0; index < args.rows.length; index++) {
    const row = args.rows[index]
    const repoId = row?.type === 'header' ? row.repo?.id : undefined
    if (!repoId) {
      continue
    }
    const bucketKey = args.repoHeaderBucketByRepoId.get(repoId)
    const usesRootSlots = bucketKey === 'ungrouped' && (args.sidebarRootSlots?.length ?? 0) > 0
    let endIndex = usesRootSlots
      ? nextRootSlotRowIndex({
          rows: args.rows,
          sidebarRootSlots: args.sidebarRootSlots,
          slot: { kind: 'repo', id: repoId },
          repoHeaderIndexByRepoId,
          projectGroupHeaderIndexByGroupId,
          fallbackStartIndex: index + 1,
          depth: 0,
          preferProjectGroupSectionEnd: false
        })
      : -1
    if (endIndex < 0) {
      const nextRepoId = bucketKey ? repoSuccessorsByBucket.get(bucketKey)?.get(repoId) : undefined
      endIndex = nextRepoId
        ? (repoHeaderIndexByRepoId.get(nextRepoId) ?? -1)
        : findNextHeaderRenderRowIndex(args.rows, index + 1)
    }
    sectionEndByRepoId.set(
      repoId,
      rowStarts[endIndex >= 0 ? endIndex : args.rows.length] ?? rowStarts[args.rows.length] ?? 0
    )
  }
  return sectionEndByRepoId
}

export function getProjectGroupHeaderSectionEndByGroupId(args: {
  rows: readonly RenderRow[]
  firstHeaderIndex: number
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<string, readonly string[]>
  projectGroupHeaderBucketByGroupId: ReadonlyMap<string, string>
  sidebarRootSlots?: readonly SidebarRootSlot[]
}): Map<string, number> {
  const rowStarts = getEstimatedRenderRowStarts(args.rows, args.firstHeaderIndex)
  const repoHeaderIndexByRepoId = indexHeaderRenderRows(args.rows, (row) => row.repo?.id)
  const projectGroupHeaderIndexByGroupId = indexHeaderRenderRows(args.rows, (row) =>
    row.repo ? undefined : row.projectGroup?.id
  )
  const groupSuccessorsByBucket = indexBucketSuccessors(args.sidebarProjectGroupHeaderIdsByBucket)
  const sectionEndByGroupId = new Map<string, number>()
  for (let index = 0; index < args.rows.length; index++) {
    const row = args.rows[index]
    const projectGroupHeader =
      row?.type === 'header' &&
      !row.repo &&
      row.projectGroup &&
      typeof row.projectGroup.id === 'string'
        ? { row, groupId: row.projectGroup.id }
        : null
    const groupId = projectGroupHeader?.groupId
    if (!groupId) {
      continue
    }
    const bucketKey = args.projectGroupHeaderBucketByGroupId.get(groupId)
    const depth = projectGroupHeader.row.projectGroupDepth ?? 0
    const usesRootSlots = bucketKey === 'root' && (args.sidebarRootSlots?.length ?? 0) > 0
    let endIndex = usesRootSlots
      ? nextRootSlotRowIndex({
          rows: args.rows,
          sidebarRootSlots: args.sidebarRootSlots,
          slot: { kind: 'project-group', id: groupId },
          repoHeaderIndexByRepoId,
          projectGroupHeaderIndexByGroupId,
          fallbackStartIndex: index + 1,
          depth,
          preferProjectGroupSectionEnd: true
        })
      : -1
    if (endIndex < 0) {
      const nextGroupId = bucketKey
        ? groupSuccessorsByBucket.get(bucketKey)?.get(groupId)
        : undefined
      endIndex = nextGroupId
        ? (projectGroupHeaderIndexByGroupId.get(nextGroupId) ?? -1)
        : findProjectGroupSectionEndIndex(args.rows, index + 1, depth)
    }
    sectionEndByGroupId.set(
      groupId,
      rowStarts[endIndex >= 0 ? endIndex : args.rows.length] ?? rowStarts[args.rows.length] ?? 0
    )
  }
  return sectionEndByGroupId
}
