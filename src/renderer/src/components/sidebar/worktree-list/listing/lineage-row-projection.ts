import { getRenderRowKey, type RenderRow } from './render-row'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { getFolderWorkspaceHostIdentity } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import type {
  GroupHeaderRow,
  WorktreeGroupBy
} from '../../../../../../shared/sidebar-list/row-types'
import {
  getFolderWorkspaceRowGeometry,
  getProjectGroupHeaderPaddingLeft,
  getWorktreeCardContentIndent,
  getWorktreeCardSurfaceInset,
  FLUSH_CARD_CONTENT_PULLBACK,
  NEW_CARD_STYLE_STATUS_LANE_EXTRA_PULLBACK,
  FLUSH_CARD_MIN_CONTENT_INSET,
  WORKTREE_CARD_SURFACE_MARGIN,
  LINEAGE_CHILDREN_INLINE_OFFSET,
  SECTION_HEADER_ICON_CENTER_OFFSET,
  SECTION_CHILD_SURFACE_GAP,
  HOST_SECTION_HEADER_GUIDE_X,
  WORKTREE_SECTION_HEADER_PADDING_LEFT
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
  // Root workspace rows under a section header: the header's rail x, and whether the row ends the section.
  sectionGuideX: number | null
  sectionLastChild: boolean
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

// Why: matches SectionHeader's own padding so the rail drops from its icon's center.
function getSectionHeaderGuideX(row: GroupHeaderRow, groupBy: WorktreeGroupBy): number {
  const paddingLeft =
    groupBy === 'repo' && (row.repo !== undefined || row.projectGroup !== undefined)
      ? getProjectGroupHeaderPaddingLeft(row.projectGroupDepth ?? 0)
      : WORKTREE_SECTION_HEADER_PADDING_LEFT
  return paddingLeft + SECTION_HEADER_ICON_CENTER_OFFSET
}

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
  const occurrencesByIdentity = new Map<string, number[]>()
  const stack: number[] = []
  const close = (next: number) => {
    const index = stack.pop()!
    frames[index].end = next - 1
  }
  // Workspace roots after a section header nest under it as tree children.
  let section: { guideX: number; rootChildren: number[] } | null = null
  const closeSection = (): void => {
    const lastRoot = section?.rootChildren.at(-1)
    if (lastRoot !== undefined) {
      frames[lastRoot].sectionLastChild = true
    }
    section = null
  }
  rows.forEach((row, index) => {
    const key = getRenderRowKey(row)
    rowKeys.push(key)
    rowIndexByKey.set(key, index)
    const isWorkspace = row.type === 'item' || row.type === 'folder-workspace'
    if (row.type === 'header' || row.type === 'host-header') {
      closeSection()
      section = {
        guideX:
          row.type === 'header'
            ? getSectionHeaderGuideX(row, groupBy)
            : HOST_SECTION_HEADER_GUIDE_X,
        rootChildren: []
      }
    }
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
      guides: null,
      sectionGuideX: null,
      sectionLastChild: false
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
      } else if (section !== null) {
        frame.left = section.guideX + SECTION_CHILD_SURFACE_GAP
        frame.sectionGuideX = section.guideX
        section.rootChildren.push(index)
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
    frames.push(frame)
    if (isWorkspace) {
      stack.push(index)
    }
  })
  while (stack.length > 0) {
    close(rows.length)
  }
  closeSection()
  frames.forEach((frame, index) => {
    if (frame.end > index) {
      frames[frame.end].closing += 7
    }
    const next = frames[index + 1]
    frame.after = next?.root === frame.root ? 0 : 6
  })
  const guideOffset = statusLane ? NEW_STYLE_GUIDE_OFFSET : LEGACY_GUIDE_OFFSET
  const guideX = (index: number) => frames[index].left - guideOffset
  frames.forEach((frame, index) => {
    const hasChildren = frame.end > index && frames[index + 1]?.parent === index
    const sectionX = frame.sectionGuideX
    if (frame.parent === null && !hasChildren && sectionX === null) {
      return
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
      // The section rail keeps passing through a section child's subtree until the section ends.
      const parentSectionX = frames[parent].sectionGuideX
      if (parentSectionX !== null && !frames[parent].sectionLastChild) {
        rails = { x: parentSectionX, next: rails }
      }
    } else if (sectionX !== null) {
      branch = {
        x: sectionX,
        to: frame.left + BRANCH_END_INSET,
        last: frame.sectionLastChild
      }
    }
    frame.guides = {
      rails,
      branch,
      stem: hasChildren ? guideX(index + 1) : null
    }
  })
  return { frames, occurrencesByIdentity, rowIndexByKey, restoreSignal: JSON.stringify(rowKeys) }
}
