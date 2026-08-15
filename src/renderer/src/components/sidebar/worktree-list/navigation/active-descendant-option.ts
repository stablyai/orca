import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { RenderRow } from '../listing/render-row'
import type { PinnedWorktreeDisplayPolicy } from '../grouping/row-types'
import { isPinnedWorktreeRow } from '../listing/renderable-rows'
import { getRenderRowWorktreeItem, renderRowContainsWorktree } from './render-row-lookup'
import { getWorktreeOptionId } from '../rows/option-dom'

export function getRenderRowOptionId(
  row: RenderRow | undefined,
  worktreeId?: string | null
): string | undefined {
  if (!row) {
    return undefined
  }
  if (row.type === 'lineage-group') {
    const targetRow = worktreeId ? row.rows.find((item) => item.worktree.id === worktreeId) : null
    return getWorktreeOptionId((targetRow ?? row.rows[0])?.rowKey ?? row.key)
  }
  if (row.type === 'item') {
    return getWorktreeOptionId(row.rowKey)
  }
  if (row.type === 'folder-workspace') {
    return getWorktreeOptionId(folderWorkspaceKey(row.folderWorkspace.id))
  }
  return undefined
}

export function getActiveDescendantOptionId(args: {
  activeWorktreeId: string | null
  primaryActiveRowKey?: string
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  renderRows: readonly RenderRow[]
  virtualItems: readonly { index: number }[]
}): string | undefined {
  if (args.activeWorktreeId === null) {
    return undefined
  }
  if (args.primaryActiveRowKey) {
    const primaryOptionId = getWorktreeOptionId(args.primaryActiveRowKey)
    for (const item of args.virtualItems) {
      const row = args.renderRows[item.index]
      if (row && getRenderRowOptionId(row, args.activeWorktreeId) === primaryOptionId) {
        return primaryOptionId
      }
    }
  }
  let fallbackOptionId: string | undefined
  for (const item of args.virtualItems) {
    const row = args.renderRows[item.index]
    if (row && renderRowContainsWorktree(row, args.activeWorktreeId)) {
      const optionId = getRenderRowOptionId(row, args.activeWorktreeId)
      if (!optionId) {
        continue
      }
      const itemRow = getRenderRowWorktreeItem(row, args.activeWorktreeId)
      if (
        args.pinnedDisplayPolicy === 'duplicate-in-groups' &&
        itemRow &&
        !isPinnedWorktreeRow(itemRow)
      ) {
        return optionId
      }
      fallbackOptionId ??= optionId
    }
  }
  return fallbackOptionId
}
