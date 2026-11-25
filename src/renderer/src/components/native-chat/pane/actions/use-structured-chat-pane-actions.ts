import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useTabGroupTabCloseCommands } from '../../../tab-group/workspace-model/useTabGroupTabCloseCommands'
import { runNativeChatSplitTarget } from '../routing/native-chat-layout-actions'
import { isBotChatTab } from '../../../bots/bot-workspace'
import type { Tab, TabGroup } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { useTranslate } from '@/i18n/use-translate'

const EMPTY_TABS: Tab[] = []
const EMPTY_GROUPS: TabGroup[] = []

/** A bot's Home stays open, as its tab's close is locked; a pinned tab closes only as one of several groups. */
export function canCloseChatPane(groupCount: number, tab: Tab | undefined): boolean {
  if (tab && isBotChatTab(tab)) {
    return false
  }
  return groupCount > 1 || !tab?.isPinned
}

export function useStructuredChatPaneActions(tabId: string, worktreeId: string, groupId: string) {
  const t = useTranslate()
  const tabs = useAppStore((state) => state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_TABS)
  const groups = useAppStore((state) => state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS)
  const groupTabs = useMemo(() => tabs.filter((tab) => tab.groupId === groupId), [tabs, groupId])
  const { closeItem } = useTabGroupTabCloseCommands({ worktreeId })
  const closeLabel =
    groups.length < 2 || groupTabs.length > 1
      ? t('auto.components.tab.bar.SortableTab.95db5f2f7d', 'Close tab')
      : t('auto.components.terminal.pane.TerminalContextMenu.8c17d6786d', 'Close Pane')
  return {
    onSplitRight: () =>
      runNativeChatSplitTarget({ kind: 'workspace-tab', unifiedTabId: tabId, groupId }, 'right'),
    onSplitDown: () =>
      runNativeChatSplitTarget({ kind: 'workspace-tab', unifiedTabId: tabId, groupId }, 'down'),
    canClosePane: canCloseChatPane(
      groups.length,
      groupTabs.find((tab) => tab.id === tabId)
    ),
    closeLabel,
    onClosePane: () => closeItem(tabId)
  }
}
