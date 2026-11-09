import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { HostSectionRow } from '../../../../../shared/sidebar-list/host-section-rows'
import type {
  PinnedWorktreeDisplayPolicy,
  SidebarHeaderIcon
} from '../../../../../shared/sidebar-list/row-types'
import { PINNED_GROUP_KEY } from '../../../../../shared/sidebar-list/group-keys'
import { getFolderWorkspaceHostIdentity } from '../../../../../shared/folder-workspaces/folder-workspace-worktree'
import { getRenderedWorkspaceRowsInSidebarOrder } from '../worktree-list/navigation/worktree-sidebar-row-preference'
import { SIDEBAR_RAIL_SHORTCUT_LIMIT } from './sidebar-rail-geometry'

export type SidebarRailRow =
  | {
      kind: 'header'
      key: string
      collapseKey: string
      label: string | undefined
      icon: SidebarHeaderIcon
      repo: Repo | undefined
      collapsed: boolean
      count: number
      separated: boolean
    }
  | { kind: 'host'; key: string; label: string; separated: boolean }
  | {
      kind: 'tile'
      key: string
      rowKey: string
      worktree: Worktree
      repo: Repo | undefined
      shortcutNumber: number | null
      inPinnedSection: boolean
      hostContextLabel: string | undefined
      showProjectName: boolean | undefined
    }

export function buildSidebarRailRows(
  rows: readonly HostSectionRow[],
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy,
  collapsedGroups: ReadonlySet<string>
): SidebarRailRow[] {
  const rendered = getRenderedWorkspaceRowsInSidebarOrder(rows, pinnedDisplayPolicy)
  const renderedByRowKey = new Map(rendered.map((row, index) => [row.rowKey, { row, index }]))
  const railRows: SidebarRailRow[] = []

  for (const row of rows) {
    if (row.type === 'host-header') {
      railRows.push({
        kind: 'host',
        key: `host:${row.hostId}`,
        label: row.label,
        separated: railRows.length > 0
      })
      continue
    }
    if (row.type === 'header') {
      const collapseKey = row.collapseKey ?? row.key
      railRows.push({
        kind: 'header',
        key: row.hostId ? `hdr:${row.hostId}:${row.key}` : `hdr:${row.key}`,
        collapseKey,
        label: row.label,
        icon: row.icon,
        repo: row.repo,
        collapsed: collapsedGroups.has(collapseKey),
        count: row.count,
        separated: railRows.length > 0
      })
      continue
    }
    if (row.type === 'item' || row.type === 'folder-workspace') {
      const entry = renderedByRowKey.get(
        row.type === 'item' ? row.rowKey : getFolderWorkspaceHostIdentity(row.folderWorkspace)
      )
      if (!entry) {
        continue
      }
      railRows.push({
        kind: 'tile',
        key: `tile:${entry.row.rowKey}`,
        rowKey: entry.row.rowKey,
        worktree: entry.row.worktree,
        repo: entry.row.repo,
        shortcutNumber: entry.index < SIDEBAR_RAIL_SHORTCUT_LIMIT ? entry.index + 1 : null,
        inPinnedSection: row.type === 'item' && row.sectionKey === PINNED_GROUP_KEY,
        hostContextLabel: row.type === 'item' ? row.hostContextLabel : undefined,
        showProjectName: row.type === 'item' ? row.showProjectName : undefined
      })
    }
  }
  return railRows
}
