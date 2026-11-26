import {
  getRootProjectHeaderKey,
  getRootProjectHeaderOccurrenceKey
} from '../drag/root-project-header-drop'
import { estimateRenderRowSize } from './virtual-rows'
import type { RenderRow } from '../listing/render-row'
import {
  getHeaderDragRepo,
  type GroupHeaderRow
} from '../../../../../../shared/sidebar-list/row-types'

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

export function getRepoHeaderSectionEndByKey(args: {
  rows: readonly RenderRow[]
  firstHeaderIndex: number
  sidebarRepoHeaderKeysByBucket: ReadonlyMap<string, readonly string[]>
  repoHeaderBucketByKey: ReadonlyMap<string, string>
  keyOf?: (row: GroupHeaderRow) => string | undefined
}): Map<string, number> {
  const rowStarts = getEstimatedRenderRowStarts(args.rows, args.firstHeaderIndex)
  const keyOf = args.keyOf ?? ((row: GroupHeaderRow) => getHeaderDragRepo(row)?.id)
  const repoHeaderIndexByBucketAndRepoId = indexHeaderRenderRows(args.rows, (row) =>
    getHeaderDragRepo(row)
      ? JSON.stringify([args.repoHeaderBucketByKey.get(keyOf(row) ?? ''), keyOf(row)])
      : undefined
  )
  const repoSuccessorsByBucket = indexBucketSuccessors(args.sidebarRepoHeaderKeysByBucket)
  const sectionEndByKey = new Map<string, number>()
  for (let index = 0; index < args.rows.length; index++) {
    const row = args.rows[index]
    if (row?.type !== 'header' || !getHeaderDragRepo(row)?.id) {
      continue
    }
    const rowKey = keyOf(row)
    if (!rowKey) {
      continue
    }
    const bucketKey = args.repoHeaderBucketByKey.get(rowKey)
    const nextRepoId = bucketKey ? repoSuccessorsByBucket.get(bucketKey)?.get(rowKey) : undefined
    const endIndex = nextRepoId
      ? (repoHeaderIndexByBucketAndRepoId.get(JSON.stringify([bucketKey, nextRepoId])) ?? -1)
      : findNextHeaderRenderRowIndex(args.rows, index + 1)
    sectionEndByKey.set(
      rowKey,
      rowStarts[endIndex >= 0 ? endIndex : args.rows.length] ?? rowStarts[args.rows.length] ?? 0
    )
  }
  return sectionEndByKey
}

export function getProjectGroupHeaderSectionEndByGroupId(args: {
  rows: readonly RenderRow[]
  firstHeaderIndex: number
}): Map<string, number> {
  const rowStarts = getEstimatedRenderRowStarts(args.rows, args.firstHeaderIndex)
  const sectionEndByGroupId = new Map<string, number>()
  const pendingGroups: { groupId: string; depth: number }[] = []
  for (let index = 0; index < args.rows.length; index++) {
    const row = args.rows[index]
    if (row.type !== 'header' && row.type !== 'host-header') {
      continue
    }
    const depth =
      row.type === 'host-header' || (!row.repo && !row.projectGroup)
        ? Number.NEGATIVE_INFINITY
        : (row.projectGroupDepth ?? 0)
    while (pendingGroups.length > 0) {
      const pending = pendingGroups.at(-1)
      if (!pending || pending.depth < depth) {
        break
      }
      pendingGroups.pop()
      sectionEndByGroupId.set(pending.groupId, rowStarts[index])
    }
    if (row.type === 'header' && !row.repo && !row.repeated && row.projectGroup?.id) {
      const groupId = row.projectGroup.id
      sectionEndByGroupId.set(groupId, rowStarts[args.rows.length])
      pendingGroups.push({ groupId, depth: row.projectGroupDepth ?? 0 })
    }
  }
  return sectionEndByGroupId
}

export function getRootProjectHeaderSectionEndByKey(
  rows: readonly RenderRow[],
  firstHeaderIndex: number
): Map<string, number> {
  const rowStarts = getEstimatedRenderRowStarts(rows, firstHeaderIndex)
  const ends = new Map<string, number>()
  let pendingKey: string | undefined
  for (const [index, row] of rows.entries()) {
    const key = row.type === 'header' ? getRootProjectHeaderKey(row) : undefined
    const closesSection =
      key || row.type === 'host-header' || (row.type === 'header' && !row.repo && !row.projectGroup)
    if (closesSection) {
      if (pendingKey) {
        ends.set(pendingKey, rowStarts[index])
      }
      pendingKey =
        key && row.type === 'header'
          ? getRootProjectHeaderOccurrenceKey(key, row.hostId)
          : undefined
    }
  }
  if (pendingKey) {
    ends.set(pendingKey, rowStarts[rows.length])
  }
  return ends
}
