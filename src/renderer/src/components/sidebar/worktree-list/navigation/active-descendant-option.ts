import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { RenderRow } from '../listing/render-row'
import {
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { PinnedWorktreeDisplayPolicy } from '../grouping/row-types'
import { isPinnedWorktreeRow } from '../listing/renderable-rows'
import { getRenderRowWorktreeItem, renderRowContainsWorktree } from './render-row-lookup'
import { getWorktreeOptionId } from '../rows/option-dom'

export function getRenderRowOptionId(
  row: RenderRow | undefined,
  worktreeId?: string | null,
  executionHostId?: ExecutionHostId
): string | undefined {
  if (!row) {
    return undefined
  }
  if (row.type === 'lineage-group') {
    // Hostless legacy state cannot disambiguate, but an aria pointer should still target a row.
    const targetRow = worktreeId
      ? row.rows.find(
          (item) =>
            item.worktree.id === worktreeId &&
            (executionHostId === undefined ||
              getWorktreeExecutionHostId(item.worktree, item.repo) === executionHostId)
        )
      : null
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
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
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
      if (
        row &&
        getRenderRowOptionId(
          row,
          args.activeWorktreeId,
          args.activeWorkspaceExecutionHostId ?? undefined
        ) === primaryOptionId
      ) {
        return primaryOptionId
      }
    }
  }
  let fallbackOptionId: string | undefined
  for (const item of args.virtualItems) {
    const row = args.renderRows[item.index]
    if (
      row &&
      renderRowContainsWorktree(
        row,
        args.activeWorktreeId,
        args.activeWorkspaceExecutionHostId ?? undefined
      )
    ) {
      const optionId = getRenderRowOptionId(
        row,
        args.activeWorktreeId,
        args.activeWorkspaceExecutionHostId ?? undefined
      )
      if (!optionId) {
        continue
      }
      const itemRow = getRenderRowWorktreeItem(
        row,
        args.activeWorktreeId,
        args.activeWorkspaceExecutionHostId ?? undefined
      )
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
