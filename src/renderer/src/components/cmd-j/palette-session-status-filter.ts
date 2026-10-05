import {
  resolveTerminalTabAttentionBadge,
  terminalTabHasUnreadActivity
} from '@/components/tab-bar/terminal-tab-activity-status'
import type { ReadableAgentAttentionUnread } from '@/attention/agent-attention-contract'
import type { TabPaneInputSources } from '@/components/sidebar/smart-attention'
import { resolveRecentWorkspaceTabStatus } from '@/lib/recent-workspace-tab-rows'
import type { SearchableWorkspaceTab } from '@/lib/workspace-tab-palette-search'
import type { WorktreeStatus } from '@/lib/worktree-status'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

export function matchesPaletteSessionStatus(
  statusIds: readonly string[],
  status: WorktreeStatus | null,
  hasUnread: boolean
): boolean {
  if (statusIds.length === 0) {
    return true
  }
  if (status === null) {
    return false
  }
  const badge = resolveTerminalTabAttentionBadge({ status, hasUnread })
  return statusIds.some((id) => {
    switch (id) {
      case 'waiting':
        return badge === 'permission'
      case 'finished':
        return badge === 'done' || badge === 'unread'
      case 'working':
        return badge === 'working' || badge === 'monitoring'
      case 'idle':
        return badge === null
      default:
        return false
    }
  })
}

type PaletteSessionFilterInput = {
  statusIds: readonly string[]
  tabsByWorktree: Record<string, readonly TerminalTab[] | undefined>
  paneSources: TabPaneInputSources
  unreadTerminalTabs: Record<string, ReadableAgentAttentionUnread>
  unreadAgentCompletionPanes: Record<string, ReadableAgentAttentionUnread>
  now: number
}

export function filterPaletteSessionEntries(
  entries: SearchableWorkspaceTab[],
  input: PaletteSessionFilterInput
): SearchableWorkspaceTab[] {
  if (input.statusIds.length === 0) {
    return entries
  }
  const tabsByWorktree = new Map<string, Map<string, TerminalTab | null>>()
  return entries.filter((entry) => {
    if (entry.tab.contentType !== 'terminal' || entry.worktree.isArchived) {
      return false
    }
    let tabs = tabsByWorktree.get(entry.worktree.id)
    if (!tabs) {
      tabs = new Map()
      for (const tab of input.tabsByWorktree[entry.worktree.id] ?? []) {
        tabs.set(tab.id, tabs.has(tab.id) ? null : tab)
      }
      tabsByWorktree.set(entry.worktree.id, tabs)
    }
    const terminalTab = tabs.get(entry.tab.entityId)
    if (!terminalTab) {
      return false
    }
    const status = resolveRecentWorkspaceTabStatus(
      {
        id: entry.tab.id,
        worktreeId: entry.worktree.id,
        unifiedTabId: entry.tab.id,
        terminalTab,
        worktreeLastActivityAt: entry.worktree.lastActivityAt
      },
      input.paneSources,
      input.now
    )
    return matchesPaletteSessionStatus(
      input.statusIds,
      status,
      terminalTabHasUnreadActivity({
        terminalTabId: terminalTab.id,
        unreadTerminalTabs: input.unreadTerminalTabs,
        unreadAgentCompletionPanes: input.unreadAgentCompletionPanes
      })
    )
  })
}
