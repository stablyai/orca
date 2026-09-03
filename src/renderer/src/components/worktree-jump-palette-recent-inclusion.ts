import {
  resolveTerminalTabAttentionBadge,
  terminalTabHasUnreadActivity
} from '@/components/tab-bar/terminal-tab-activity-status'
import { resolveRecentWorkspaceTabStatus } from '@/lib/recent-workspace-tab-rows'
import type { TabPaneInputSources } from '@/components/sidebar/smart-attention'
import type { OpenTabPaletteItem, OpenTabRecentRow } from './worktree-jump-palette-model'
import type { Worktree } from '../../../shared/worktree/types'

function isCurrentOpenTabItem(item: OpenTabPaletteItem): boolean {
  return item.type === 'browser-page' ? item.result.isCurrentPage : item.result.isCurrentTab
}

export function shouldIncludeOpenTabInRecentSection({
  item,
  worktree,
  row,
  paneSources,
  unreadTerminalTabs,
  unreadAgentCompletionPanes,
  now
}: {
  item: OpenTabPaletteItem
  worktree: Worktree
  row: OpenTabRecentRow['row']
  paneSources: TabPaneInputSources
  unreadTerminalTabs: Record<string, boolean | undefined>
  unreadAgentCompletionPanes: Record<string, boolean | undefined>
  now: number
}): boolean {
  if (worktree.isArchived) {
    return false
  }
  if (!isCurrentOpenTabItem(item)) {
    return true
  }
  if (!row.terminalTab) {
    return false
  }
  const badge = resolveTerminalTabAttentionBadge({
    status: resolveRecentWorkspaceTabStatus(row, paneSources, now),
    hasUnread: terminalTabHasUnreadActivity({
      terminalTabId: row.terminalTab.id,
      unreadTerminalTabs,
      unreadAgentCompletionPanes
    })
  })
  return badge != null && badge !== 'done' && badge !== 'interrupted'
}
