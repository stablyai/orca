import {
  getRootProjectHeaderKey,
  getRootProjectHeaderOccurrenceKey
} from '../drag/root-project-header-drop'
import { estimateRenderRowSize } from './virtual-rows'
import type { RenderRow } from '../listing/render-row'
import { getHeaderDragRepo } from '../../../../../../shared/sidebar-list/row-types'

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

function findNextHeaderRenderRowIndex(rows: readonly RenderRow[], startIndex: number): number {
  for (let index = startIndex; index < rows.length; index++) {
    const row = rows[index]
    if (row?.type === 'header' || row?.type === 'host-header') {
      return index
    }
  }
  return rows.length
}

export function getRepoHeaderSectionEndByRepoId(args: {
  rows: readonly RenderRow[]
  firstHeaderIndex: number
}): Map<string, number> {
  const rowStarts = getEstimatedRenderRowStarts(args.rows, args.firstHeaderIndex)
  const sectionEndByRepoId = new Map<string, number>()
  for (let index = 0; index < args.rows.length; index++) {
    const row = args.rows[index]
    const repoId = row?.type === 'header' ? getHeaderDragRepo(row)?.id : undefined
    if (!repoId) {
      continue
    }
    const endIndex = findNextHeaderRenderRowIndex(args.rows, index + 1)
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
