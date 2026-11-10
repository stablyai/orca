import {
  PINNED_GROUP_KEY,
  getWorktreeLineageGroupKey
} from '../../../../../../shared/sidebar-list/group-keys'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import type { RenderRow } from './render-row'

export type WorktreeItemRow = Extract<HostSectionRow, { type: 'item' }>
export type FolderWorkspaceItemRow = Extract<HostSectionRow, { type: 'folder-workspace' }>

export function isWorktreeItemRow(row: HostSectionRow): row is WorktreeItemRow {
  return row.type === 'item'
}

export function isPinnedWorktreeRow(row: WorktreeItemRow): boolean {
  return row.sectionKey === PINNED_GROUP_KEY
}

// Collapse a parent and its visible lineage descendants into one virtual row so the card renders them inline.
export function buildRenderableRows(rows: HostSectionRow[]): RenderRow[] {
  const renderRows: RenderRow[] = []
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    if (row.type === 'folder-workspace') {
      const descendants = getDescendantItemRows(rows, index, row.depth)
      if (descendants.length > 0 && row.lineageGroupKey && !row.lineageCollapsed) {
        renderRows.push({ type: 'lineage-group', key: row.key, rows: descendants, folder: row })
        index += descendants.length
      } else {
        renderRows.push(row)
      }
      continue
    }
    if (
      !isWorktreeItemRow(row) ||
      row.lineageChildCount === 0 ||
      row.lineageCollapsed ||
      rows[index + 1]?.type !== 'item' ||
      (rows[index + 1] as WorktreeItemRow).depth <= row.depth
    ) {
      renderRows.push(row)
      continue
    }

    const groupRows = [row, ...getDescendantItemRows(rows, index, row.depth)]
    renderRows.push({
      type: 'lineage-group',
      key: `${row.sectionKey}:${getWorktreeLineageGroupKey(row.worktree)}`,
      rows: groupRows
    })
    index += groupRows.length - 1
  }
  return renderRows
}

function getDescendantItemRows(
  rows: readonly HostSectionRow[],
  parentIndex: number,
  parentDepth: number
): WorktreeItemRow[] {
  const descendants: WorktreeItemRow[] = []
  for (let cursor = parentIndex + 1; cursor < rows.length; cursor++) {
    const child = rows[cursor]
    if (!isWorktreeItemRow(child) || child.depth <= parentDepth) {
      break
    }
    descendants.push(child)
  }
  return descendants
}
