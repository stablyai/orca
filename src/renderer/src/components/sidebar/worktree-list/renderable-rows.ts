import { getLineageGroupKey } from '../worktree-list-groups'
import type { HostSectionRow } from '../host-section-rows'
import type { RenderRow } from '../worktree-list-virtual-rows'
import { isWorktreeItemRow, type WorktreeItemRow } from './render-row-item-rows'

// Collapse a parent and its visible lineage descendants into one virtual row so the card renders them inline.
export function buildRenderableRows(rows: HostSectionRow[]): RenderRow[] {
  const renderRows: RenderRow[] = []
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
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

    const groupRows: WorktreeItemRow[] = [row]
    let cursor = index + 1
    while (cursor < rows.length) {
      const child = rows[cursor]
      if (!isWorktreeItemRow(child) || child.depth <= row.depth) {
        break
      }
      groupRows.push(child)
      cursor++
    }
    renderRows.push({
      type: 'lineage-group',
      key: `${row.sectionKey}:${getLineageGroupKey(row.worktree.id)}`,
      rows: groupRows
    })
    index = cursor - 1
  }
  return renderRows
}
