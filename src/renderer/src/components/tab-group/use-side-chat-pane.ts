import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { useWorkspaceSideChatTabs } from '@/runtime/use-workspace-side-chat-tabs'
import { moveTabInWorkspace } from './tab-group-layout-owner-commands'
import { getTabGroupPanelRect } from './tab-group-panel-split-target'
import { sideChatPanePlacement } from './side-chat-pane-placement'
import type { Tab, TabGroup } from '../../../../shared/tab-types'

const EMPTY_TABS: Tab[] = []
const EMPTY_GROUPS: TabGroup[] = []

export function useSideChatPane(worktreeId: string, active: boolean): void {
  const enabled = useAppStore((state) => state.settings?.nativeChatSideChatPane === true)
  const tabs = useAppStore((state) => state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_TABS)
  const groups = useAppStore((state) => state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS)
  const sideChatIds = useWorkspaceSideChatTabs(worktreeId)
  const publishedSideChatIds = useWorkspaceSideChatTabs(worktreeId, true)
  const attempted = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled || !active) {
      attempted.current = null
      return
    }
    const source = tabs.find((tab) => sideChatIds.has(tab.id))
    const rect = source ? getTabGroupPanelRect(source.groupId, worktreeId) : null
    const direction = rect && rect.width < rect.height ? 'down' : 'right'
    const placement = sideChatPanePlacement(
      tabs,
      groups,
      sideChatIds,
      direction,
      publishedSideChatIds
    )
    if (!placement) {
      attempted.current = null
      return
    }
    const key = JSON.stringify(placement)
    if (attempted.current === key) {
      return
    }
    attempted.current = key
    moveTabInWorkspace(worktreeId, placement)
  }, [enabled, active, tabs, groups, sideChatIds, publishedSideChatIds, worktreeId])
}
