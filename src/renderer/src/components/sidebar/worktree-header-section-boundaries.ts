import { estimateRenderRowSize } from './worktree-list/viewport/virtual-rows'
import type { RenderRow } from './worktree-list/listing/render-row'
import type { GroupHeaderRow } from './worktree-list/grouping/row-types'

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

// Why indexed once instead of a findIndex per header: both boundary passes ran a full row scan
// for every header row, so the sidebar row model cost O(headers x rows) on every rebuild — and it
// rebuilds on agent-status ticks, not just on drag. First match wins, matching findIndex.
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

// Kept per bucket: an id can sit in more than one bucket, and the caller's bucket lookup decides
// which ordering applies. First occurrence wins within a bucket, matching indexOf.
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
}): Map<string, number> {
  const rowStarts = getEstimatedRenderRowStarts(args.rows, args.firstHeaderIndex)
  const repoHeaderIndexByRepoId = indexHeaderRenderRows(args.rows, (row) => row.repo?.id)
  const repoSuccessorsByBucket = indexBucketSuccessors(args.sidebarRepoHeaderIdsByBucket)
  const sectionEndByRepoId = new Map<string, number>()
  for (let index = 0; index < args.rows.length; index++) {
    const row = args.rows[index]
    const repoId = row?.type === 'header' ? row.repo?.id : undefined
    if (!repoId) {
      continue
    }
    const bucketKey = args.repoHeaderBucketByRepoId.get(repoId)
    const nextRepoId = bucketKey ? repoSuccessorsByBucket.get(bucketKey)?.get(repoId) : undefined
    const endIndex = nextRepoId
      ? (repoHeaderIndexByRepoId.get(nextRepoId) ?? -1)
      : findNextHeaderRenderRowIndex(args.rows, index + 1)
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
}): Map<string, number> {
  const rowStarts = getEstimatedRenderRowStarts(args.rows, args.firstHeaderIndex)
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
    const nextGroupId = bucketKey ? groupSuccessorsByBucket.get(bucketKey)?.get(groupId) : undefined
    const depth = projectGroupHeader.row.projectGroupDepth ?? 0
    const endIndex = nextGroupId
      ? (projectGroupHeaderIndexByGroupId.get(nextGroupId) ?? -1)
      : findProjectGroupSectionEndIndex(args.rows, index + 1, depth)
    sectionEndByGroupId.set(
      groupId,
      rowStarts[endIndex >= 0 ? endIndex : args.rows.length] ?? rowStarts[args.rows.length] ?? 0
    )
  }
  return sectionEndByGroupId
}
