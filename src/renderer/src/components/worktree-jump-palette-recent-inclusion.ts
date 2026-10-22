import type { ReadableAgentAttentionUnread } from '@/attention/agent-attention-contract'
import { resolveTerminalTabAttentionBadge } from '@/components/tab-bar/terminal-tab-activity-status'
import {
  recentWorkspaceTabHasUnreadActivity,
  resolveRecentWorkspaceTabStatus
} from '@/lib/recent-workspace-tab-rows'
import type { TabPaneInputSources } from '../../../shared/sidebar-list/smart-attention'
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
  unreadTerminalTabs: Record<string, ReadableAgentAttentionUnread>
  unreadAgentCompletionPanes: Record<string, ReadableAgentAttentionUnread>
  now: number
}): boolean {
  if (worktree.isArchived) {
    return false
  }
  if (!isCurrentOpenTabItem(item)) {
    return true
  }
  if (!row.terminalTab && !row.nativeChat) {
    return false
  }
  const badge = resolveTerminalTabAttentionBadge({
    status: resolveRecentWorkspaceTabStatus(row, paneSources, now),
    hasUnread: recentWorkspaceTabHasUnreadActivity({
      row,
      unreadTerminalTabs,
      unreadAgentCompletionPanes
    })
  })
  // Why: a settled outcome on the tab you are on is not news; a failure ranks like a completion.
  return (
    badge != null &&
    badge !== 'done' &&
    badge !== 'failed' &&
    badge !== 'interrupted' &&
    badge !== 'unconfirmed'
  )
}
