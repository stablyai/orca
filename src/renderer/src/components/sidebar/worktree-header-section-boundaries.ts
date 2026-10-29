import { estimateRenderRowSize } from './worktree-list/viewport/virtual-rows'
import type { RenderRow } from './worktree-list/listing/render-row'
import type { GroupHeaderRow } from '../../../../shared/sidebar-list/row-types'

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

/** Maps every render row to the repo header whose section it renders under, so
 *  a whole project section can move as one block during a header drag. Headers
 *  delimit sections in the flat row model: a repo header opens one, any other
 *  header (project group, pinned/status, host) closes it. */
export function getRepoSectionRepoIdByRowIndex(rows: readonly RenderRow[]): (string | undefined)[] {
  const repoIdByRowIndex: (string | undefined)[] = []
  let sectionRepoId: string | undefined
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    if (row?.type === 'header' || row?.type === 'host-header') {
      sectionRepoId = row.type === 'header' ? row.repo?.id : undefined
    }
    repoIdByRowIndex[index] = sectionRepoId
  }
  return repoIdByRowIndex
}

export function getRepoSectionPreviewOffsetY(args: {
  repoSectionRepoIdByRowIndex: readonly (string | undefined)[]
  rowIndex: number
  previewOffsetsByRepoId?: ReadonlyMap<string, number>
  draggingRepoId?: string | null
  draggedSectionOffsetY?: number | null
}): number {
  const repoId = args.repoSectionRepoIdByRowIndex[args.rowIndex]
  // Why: the pointer moves the source section; preview offsets only park the
  // neighbouring sections around its destination gap.
  if (repoId !== undefined && repoId === args.draggingRepoId) {
    return args.draggedSectionOffsetY ?? 0
  }
  return repoId === undefined ? 0 : (args.previewOffsetsByRepoId?.get(repoId) ?? 0)
}

/** Source rows follow the pointer directly. A transform transition on them lags the cursor. */
export function shouldAnimateProjectHeaderDragRow(args: {
  draggingRepoId: string | null
  settling: boolean
  repoSectionRepoIdByRowIndex: readonly (string | undefined)[]
  rowIndex: number
}): boolean {
  if (args.draggingRepoId === null) {
    return false
  }
  if (args.settling) {
    return true
  }
  return args.repoSectionRepoIdByRowIndex[args.rowIndex] !== args.draggingRepoId
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
