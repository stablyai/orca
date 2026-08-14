import type { Worktree } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { ImportedWorktreeCardActionState } from './imported-worktrees-card-actions'
import type { HostSectionRow } from './host-section-rows'
import {
  ALL_GROUP_KEY,
  getLineageGroupKey,
  PINNED_GROUP_KEY,
  type PinnedWorktreeDisplayPolicy,
  type Row
} from './worktree-list-groups'
import type { WorktreeDragGroup } from './worktree-manual-order'
import type { RenderRow } from './worktree-list-virtual-rows'
import { getWorktreeOptionId } from './worktree-list-dom-activation'

export type WorktreeItemRow = Extract<HostSectionRow, { type: 'item' }>

export function getRenderRowSidebarKey(row: RenderRow): string | null {
  if (row.type === 'header') {
    return row.key
  }
  if (row.type === 'item') {
    return row.rowKey
  }
  if (row.type === 'folder-workspace') {
    return folderWorkspaceKey(row.folderWorkspace.id)
  }
  if (row.type === 'pending-creation') {
    return `pending:${row.creationId}`
  }
  if (row.type === 'imported-worktrees-card' || row.type === 'new-external-worktrees-inbox') {
    return row.key
  }
  return null
}

export function rowKeyMatchesRenderRow(row: RenderRow, rowKey: string): boolean {
  if (row.type === 'lineage-group') {
    return row.rows.some((item) => item.rowKey === rowKey)
  }
  return getRenderRowSidebarKey(row) === rowKey
}

function isWorktreeItemRow(row: HostSectionRow): row is WorktreeItemRow {
  return row.type === 'item'
}

export function renderRowContainsWorktree(row: RenderRow, worktreeId: string | null): boolean {
  if (worktreeId === null) {
    return false
  }
  if (row.type === 'folder-workspace') {
    return folderWorkspaceKey(row.folderWorkspace.id) === worktreeId
  }
  if (row.type === 'lineage-group') {
    return row.rows.some((item) => item.worktree.id === worktreeId)
  }
  return row.type === 'item' && row.worktree.id === worktreeId
}

export function isPinnedWorktreeRow(row: WorktreeItemRow): boolean {
  return row.sectionKey === PINNED_GROUP_KEY
}

function getRenderRowWorktreeItem(row: RenderRow, worktreeId: string): WorktreeItemRow | null {
  if (row.type === 'lineage-group') {
    return row.rows.find((item) => item.worktree.id === worktreeId) ?? null
  }
  return row.type === 'item' && row.worktree.id === worktreeId ? row : null
}

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

export function findPreferredRenderRowIndexForWorktree(
  renderRows: readonly RenderRow[],
  worktreeId: string,
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
): number {
  let fallbackIndex = -1
  for (let index = 0; index < renderRows.length; index++) {
    const row = renderRows[index]
    if (!renderRowContainsWorktree(row, worktreeId)) {
      continue
    }
    fallbackIndex = fallbackIndex === -1 ? index : fallbackIndex
    const itemRow = getRenderRowWorktreeItem(row, worktreeId)
    if (pinnedDisplayPolicy === 'duplicate-in-groups' && itemRow && !isPinnedWorktreeRow(itemRow)) {
      return index
    }
  }
  return fallbackIndex
}

export function getPinnedWorktreeRevealCollapsedGroupKeys({
  worktree,
  collapsedGroups
}: {
  worktree: Worktree
  collapsedGroups: ReadonlySet<string>
}): string[] {
  if (!worktree.isPinned) {
    return []
  }
  const keys: string[] = []
  // Why: the reveal effect already opens this host; re-returning it would toggle it back closed.
  if (collapsedGroups.has(PINNED_GROUP_KEY)) {
    keys.push(PINNED_GROUP_KEY)
  }
  return keys
}

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

export function getWorktreeDragGroups(rows: HostSectionRow[]): WorktreeDragGroup[] {
  const groups: WorktreeDragGroup[] = []
  let current: { key: string; ids: string[] } | null = null
  const naturalWorktreeIds = new Set(
    rows.flatMap((row) =>
      row.type === 'item' && row.sectionKey !== PINNED_GROUP_KEY ? [row.worktree.id] : []
    )
  )
  for (const row of rows) {
    if (row.type === 'header') {
      current = { key: row.key, ids: [] }
      groups.push({ key: current.key, worktreeIds: current.ids })
      continue
    }
    if (
      row.type === 'host-header' ||
      row.type === 'imported-worktrees-card' ||
      row.type === 'new-external-worktrees-inbox' ||
      row.type === 'pending-creation' ||
      row.type === 'folder-workspace'
    ) {
      continue
    }
    if (row.sectionKey === PINNED_GROUP_KEY && naturalWorktreeIds.has(row.worktree.id)) {
      continue
    }
    if (!current) {
      current = { key: ALL_GROUP_KEY, ids: [] }
      groups.push({ key: current.key, worktreeIds: current.ids })
    }
    current.ids.push(row.worktree.id)
  }
  return groups.filter((group) => group.worktreeIds.length > 0)
}

export function canKeepImportedWorktreesHidden(
  row: Extract<Row, { type: 'imported-worktrees-card' }>,
  actionState: ImportedWorktreeCardActionState | undefined
): boolean {
  return row.placement === 'repo-group' && actionState?.forceVisible !== true
}
