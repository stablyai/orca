import { useAppStore } from '@/store'
import { useMemo } from 'react'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { RenderRow } from './render-row'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import { getFolderWorkspaceHostIdentity } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import {
  getFolderWorkspaceRowGeometry,
  getWorktreeCardContentIndent,
  getWorktreeCardSurfaceInset,
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
}

export type LineageRowProjection = ReturnType<typeof buildLineageRowProjection>

export function buildLineageRowProjection(
  rows: readonly RenderRow[],
  groupBy: WorktreeGroupBy,
  newCardStyle: boolean,
  statusLane = newCardStyle
) {
  const frames: LineageRowFrame[] = []
  const occurrencesByIdentity = new Map<string, number[]>()
  const occurrencesByWorkspaceId = new Map<string, number[]>()
  const stack: number[] = []
  const close = (next: number) => {
    const index = stack.pop()!
    frames[index].end = next - 1
  }
  rows.forEach((row, index) => {
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
      closing: 0
    }
    if (isWorkspace) {
      const geometry =
        row.type === 'folder-workspace'
          ? getFolderWorkspaceRowGeometry({
              experimentalNewWorktreeCardStyle: newCardStyle,
              isFolderBackedWorkspaceChild:
                groupBy === 'repo' && row.projectGroup.createdFrom === 'folder-scan',
              isGrouped: groupBy !== 'none',
              groupDepth: row.groupDepth,
              lineageDepth: row.depth
            })
          : {
              surfaceInset: getWorktreeCardSurfaceInset({
                isGrouped: groupBy !== 'none',
                groupDepth: row.groupDepth
              }),
              cardContentIndent:
                getWorktreeCardContentIndent({
                  isGrouped: groupBy !== 'none',
                  groupDepth: row.groupDepth,
                  lineageDepth: row.depth
                }) -
                getWorktreeCardSurfaceInset({
                  isGrouped: groupBy !== 'none',
                  groupDepth: row.groupDepth
                })
            }
      frame.left = geometry.surfaceInset
      frame.contentIndent = Math.max(0, geometry.cardContentIndent)
      if (parent !== null) {
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
      const id = getWorktreeIdFromHostIdentity(identity)
      const sameId = occurrencesByWorkspaceId.get(id)
      if (sameId) {
        sameId.push(index)
      } else {
        occurrencesByWorkspaceId.set(id, [index])
      }
    }
    frames.push(frame)
    if (isWorkspace) {
      stack.push(index)
    }
  })
  while (stack.length > 0) {
    close(rows.length)
  }
  frames.forEach((frame, index) => {
    if (frame.end > index) {
      frames[frame.end].closing += 7
    }
    const next = frames[index + 1]
    frame.after = next?.root === frame.root ? 0 : 6
  })
  return { frames, occurrencesByIdentity, occurrencesByWorkspaceId }
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
  const activeFamilyRoots = useMemo(() => {
    const roots = new Set<number>()
    if (activeWorktreeId) {
      const occurrences = activeWorkspaceExecutionHostId
        ? projection.occurrencesByIdentity.get(
            composeWorktreeHostIdentity(activeWorkspaceExecutionHostId, activeWorktreeId)
          )
        : projection.occurrencesByWorkspaceId.get(activeWorktreeId)
      for (const index of occurrences ?? []) {
        const root = projection.frames[index].root
        if (projection.frames[root].end > root) {
          roots.add(root)
        }
      }
    }
    return roots
  }, [activeWorktreeId, activeWorkspaceExecutionHostId, projection])
  return { projection, activeFamilyRoots, firstHeaderIndex }
}
