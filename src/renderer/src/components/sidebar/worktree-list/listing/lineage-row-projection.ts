import { useAppStore } from '@/store'
import { useMemo } from 'react'
import { fingerprintStringList } from '../../../../../../shared/text/string-fingerprint'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { getRenderRowKey, type RenderRow } from './render-row'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import { getFolderWorkspaceHostIdentity } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import {
  getFolderWorkspaceRowGeometry,
  getWorktreeCardContentIndentDirect,
  getWorktreeCardSurfaceInsetDirect,
  FLUSH_CARD_CONTENT_PULLBACK,
  NEW_CARD_STYLE_STATUS_LANE_EXTRA_PULLBACK,
  FLUSH_CARD_MIN_CONTENT_INSET,
  WORKTREE_CARD_SURFACE_MARGIN,
  LINEAGE_CHILDREN_INLINE_OFFSET
} from '../rows/indentation'

export type LineageRowFrame = {
  parent: number | null
  root: number
  end: number
  left: number
  right: number
  contentIndent: number
  before: number
  after: number
  closing: number
  guides: LineageRowGuides | null
}

/** One ancestor line passing through a row; rows share their parent's tail so building is O(1). */
export type LineageRail = { readonly x: number; readonly next: LineageRail | null }

/** Tree connector x-offsets (row-relative px) that tie a nested workspace to its parent. */
export type LineageRowGuides = {
  // Ancestors whose later children sit below this row, so their line passes straight through.
  rails: LineageRail | null
  // The elbow from the immediate parent's line into this row's card.
  branch: { x: number; to: number; last: boolean } | null
  // This row's own line down to its first visible child.
  stem: number | null
}

// Why: children inset LINEAGE_CHILDREN_INLINE_OFFSET from the parent's status lane, so the lane
// center sits this far left of the child surface (w-5 new-style lane vs size-4 legacy dot).
const NEW_STYLE_GUIDE_OFFSET = 8
const LEGACY_GUIDE_OFFSET = 10
// Why: ends the elbow on the child card's left border (ml-1 margin + 1px border).
const BRANCH_END_INSET = WORKTREE_CARD_SURFACE_MARGIN + 1

export type LineageRowProjection = ReturnType<typeof buildLineageRowProjection>

export function buildLineageRowProjection(
  rows: readonly RenderRow[],
  groupBy: WorktreeGroupBy,
  newCardStyle: boolean,
  statusLane = newCardStyle
) {
  const rowIndexByKey = new Map<string, number>()
  const rowKeys: string[] = []
  const frames: LineageRowFrame[] = []
  const stack: number[] = []
  const isGrouped = groupBy !== 'none'
  let hasNestedLineage = false
  let hasCollapsedLineage = false
  const close = (next: number) => {
    const index = stack.pop()!
    frames[index].end = next - 1
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const key = getRenderRowKey(row)
    rowKeys.push(key)
    rowIndexByKey.set(key, index)
    const isWorkspace = row.type === 'item' || row.type === 'folder-workspace'
    while (stack.length > 0) {
      const parent = rows[stack.at(-1)!]
      if (
        isWorkspace &&
        (parent.type === 'item' || parent.type === 'folder-workspace') &&
        parent.depth < row.depth
      ) {
        break
      }
      close(index)
    }
    const parent = isWorkspace ? (stack.at(-1) ?? null) : null
    const frame: LineageRowFrame = {
      parent,
      root: parent === null ? index : frames[parent].root,
      end: index,
      left: 0,
      right: 0,
      contentIndent: 0,
      before: 0,
      after: 6,
      closing: 0,
      guides: null
    }
    if (isWorkspace) {
      if (row.type === 'folder-workspace') {
        const geometry = getFolderWorkspaceRowGeometry({
          experimentalNewWorktreeCardStyle: newCardStyle,
          isFolderBackedWorkspaceChild:
            groupBy === 'repo' && row.projectGroup.createdFrom === 'folder-scan',
          isGrouped,
          groupDepth: row.groupDepth,
          lineageDepth: row.depth
        })
        frame.left = geometry.surfaceInset
        frame.contentIndent = Math.max(0, geometry.cardContentIndent)
      } else {
        const surfaceInset = getWorktreeCardSurfaceInsetDirect(isGrouped, row.groupDepth)
        const contentIndent =
          getWorktreeCardContentIndentDirect(isGrouped, row.groupDepth, row.depth) - surfaceInset
        frame.left = surfaceInset
        frame.contentIndent = Math.max(0, contentIndent)
      }
      if (row.lineageCollapsed === true) {
        hasCollapsedLineage = true
      }
      if (parent !== null) {
        hasNestedLineage = true
        const ancestor = frames[parent]
        const padding = Math.max(
          FLUSH_CARD_MIN_CONTENT_INSET,
          ancestor.contentIndent -
            FLUSH_CARD_CONTENT_PULLBACK -
            (statusLane ? NEW_CARD_STYLE_STATUS_LANE_EXTRA_PULLBACK : 0)
        )
        frame.left =
          ancestor.left +
          WORKTREE_CARD_SURFACE_MARGIN +
          1 +
          padding +
          LINEAGE_CHILDREN_INLINE_OFFSET
        frame.right = ancestor.right + 7
        frame.contentIndent = 0
        frame.before = parent === index - 1 ? (newCardStyle ? 6 : 12) : 4
      }
    }
    frames.push(frame)
    if (isWorkspace) {
      stack.push(index)
    }
  }
  while (stack.length > 0) {
    close(rows.length)
  }
  if (hasNestedLineage) {
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index]
      if (frame.end > index) {
        frames[frame.end].closing += 7
      }
      const next = frames[index + 1]
      frame.after = next?.root === frame.root ? 0 : 6
    }
    const guideOffset = statusLane ? NEW_STYLE_GUIDE_OFFSET : LEGACY_GUIDE_OFFSET
    const guideX = (index: number) => frames[index].left - guideOffset
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index]
      const hasChildren = frame.end > index && frames[index + 1]?.parent === index
      if (frame.parent === null && !hasChildren) {
        continue
      }
      let rails: LineageRail | null = null
      let branch: LineageRowGuides['branch'] = null
      const parent = frame.parent
      if (parent !== null) {
        branch = {
          x: guideX(index),
          to: frame.left + BRANCH_END_INSET,
          last: frame.end === frames[parent].end
        }
        // Why: this runs for every row before virtualization, so extend the parent's shared rail list
        // in O(1) instead of walking or copying ancestors; only visible rows walk it to paint.
        const parentRails = frames[parent].guides!.rails
        const grandparent = frames[parent].parent
        rails =
          grandparent !== null && frames[parent].end < frames[grandparent].end
            ? { x: guideX(parent), next: parentRails }
            : parentRails
      }
      frame.guides = {
        rails,
        branch,
        stem: hasChildren ? guideX(index + 1) : null
      }
    }
  }
  let cachedOccurrencesByIdentity: Map<string, number[]> | null = null
  const hasAnyLineageFamily = hasNestedLineage || hasCollapsedLineage
  return {
    frames,
    hasAnyLineageFamily,
    get occurrencesByIdentity(): Map<string, number[]> {
      if (!cachedOccurrencesByIdentity) {
        cachedOccurrencesByIdentity = buildOccurrencesByIdentity(rows)
      }
      return cachedOccurrencesByIdentity
    },
    rowIndexByKey,
    restoreSignal: fingerprintStringList(rowKeys)
  }
}

function buildOccurrencesByIdentity(rows: readonly RenderRow[]): Map<string, number[]> {
  const occurrencesByIdentity = new Map<string, number[]>()
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row.type !== 'item' && row.type !== 'folder-workspace') {
      continue
    }
    const identity =
      row.type === 'item'
        ? getWorktreeHostIdentity(row.worktree)
        : getFolderWorkspaceHostIdentity(row.folderWorkspace)
    const occurrences = occurrencesByIdentity.get(identity)
    if (occurrences) {
      occurrences.push(index)
    } else {
      occurrencesByIdentity.set(identity, [index])
    }
  }
  return occurrencesByIdentity
}

export function useDraggedSubtreeRanges(
  projection: LineageRowProjection,
  identity: string | null
): readonly { start: number; end: number }[] {
  return useMemo(
    () =>
      (identity ? (projection.occurrencesByIdentity.get(identity) ?? []) : []).map((start) => ({
        start,
        end: projection.frames[start].end
      })),
    [projection, identity]
  )
}

function hasHiddenLineageChildren(row: RenderRow): boolean {
  return (row.type === 'item' || row.type === 'folder-workspace') && row.lineageCollapsed === true
}

export function getActiveFamilyRoots(
  rows: readonly RenderRow[],
  projection: LineageRowProjection,
  activeWorktreeId: string | null,
  activeWorkspaceExecutionHostId: ExecutionHostId | null
): Set<number> {
  const roots = new Set<number>()
  if (!activeWorktreeId || !projection.hasAnyLineageFamily) {
    return roots
  }
  const addRoots = (occurrences: readonly number[]) => {
    for (const index of occurrences) {
      const root = projection.frames[index].root
      // A collapsed family paints its root too: the band keeps the card's own background from
      // handing back and forth when the children are shown or hidden.
      if (projection.frames[root].end > root || hasHiddenLineageChildren(rows[root])) {
        roots.add(root)
      }
    }
  }
  if (activeWorkspaceExecutionHostId) {
    addRoots(
      projection.occurrencesByIdentity.get(
        composeWorktreeHostIdentity(activeWorkspaceExecutionHostId, activeWorktreeId)
      ) ?? []
    )
  } else {
    for (const [identity, occurrences] of projection.occurrencesByIdentity) {
      if (getWorktreeIdFromHostIdentity(identity) === activeWorktreeId) {
        addRoots(occurrences)
      }
    }
  }
  return roots
}

export function useLineageRowProjection(args: {
  rows: RenderRow[]
  groupBy: WorktreeGroupBy
  newCardStyle: boolean
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
}) {
  const { rows, groupBy, newCardStyle, activeWorktreeId, activeWorkspaceExecutionHostId } = args
  const statusLane = useAppStore((s) => s.worktreeCardProperties.includes('status')) && newCardStyle
  const projection = useMemo(
    () => buildLineageRowProjection(rows, groupBy, newCardStyle, statusLane),
    [rows, groupBy, newCardStyle, statusLane]
  )
  const firstHeaderIndex = useMemo(
    () => rows.findIndex((row) => row.type === 'header' || row.type === 'host-header'),
    [rows]
  )
  const activeFamilyRoots = useMemo(
    () => getActiveFamilyRoots(rows, projection, activeWorktreeId, activeWorkspaceExecutionHostId),
    [activeWorktreeId, activeWorkspaceExecutionHostId, projection, rows]
  )
  return { projection, activeFamilyRoots, firstHeaderIndex }
}
