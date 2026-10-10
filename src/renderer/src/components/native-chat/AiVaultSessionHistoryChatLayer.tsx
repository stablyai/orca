import { memo, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import { useAppStore } from '@/store'
import { RetainedPaneHost } from '../tab-group/RetainedPaneHost'
import { AiVaultSessionHistoryChatView } from './AiVaultSessionHistoryChatView'

type HistoryChatTab = Tab & {
  contentType: 'agent-session'
  agentSessionAgent: 'zcode'
}

/** An Agent Session History tab this build renders read-only: zcode has no structured host
 *  adapter, so its history chats are the vault row's tab viewed through the live-session hook. */
function isAiVaultHistoryChatTab(tab: Tab): tab is HistoryChatTab {
  return tab.contentType === 'agent-session' && tab.agentSessionAgent === 'zcode'
}

const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_GROUPS: readonly TabGroup[] = []

const HistoryChatOverlaySlot = memo(function HistoryChatOverlaySlot({
  tab,
  groupId,
  isActive,
  isFocusedGroup,
  onFocusOwningGroup
}: {
  tab: HistoryChatTab
  groupId: string | undefined
  isActive: boolean
  isFocusedGroup: boolean
  onFocusOwningGroup: ((groupId: string) => void) | undefined
}): React.JSX.Element {
  return (
    <RetainedPaneHost
      groupId={groupId}
      isVisible={isActive}
      data-ai-vault-history-chat-overlay-tab-id={tab.id}
      onFocusOwningGroup={onFocusOwningGroup}
    >
      <AiVaultSessionHistoryChatView
        tabId={tab.id}
        sessionId={tab.entityId}
        agent={tab.agentSessionAgent}
        isVisible={isActive}
        isFocusedGroup={isFocusedGroup}
      />
    </RetainedPaneHost>
  )
})

/**
 * The retained pane hosts for the workspace's Agent Session History chat tabs (zcode today).
 * Mirrors `StructuredAgentSessionPaneOverlayLayer`, which owns the same tab content type for
 * host-registered structured agents; this layer answers for the agents a chat can only render.
 */
const AiVaultSessionHistoryChatLayer = memo(function AiVaultSessionHistoryChatLayer({
  worktreeId,
  isWorktreeActive
}: {
  worktreeId: string
  isWorktreeActive: boolean
}): React.JSX.Element | null {
  const { unifiedTabs, groups, activeGroupId } = useAppStore(
    useShallow((state) => ({
      unifiedTabs: state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_UNIFIED_TABS,
      groups: state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS,
      activeGroupId: state.activeGroupIdByWorktree[worktreeId]
    }))
  )
  const focusOwningGroup = useMemo(
    () => (groupId: string) => {
      useAppStore.getState().focusGroup(worktreeId, groupId)
    },
    [worktreeId]
  )
  const groupActiveTabById = useMemo(
    () => new Map(groups.map((group) => [group.id, group.activeTabId] as const)),
    [groups]
  )
  const historyTabs = useMemo(() => unifiedTabs.filter(isAiVaultHistoryChatTab), [unifiedTabs])
  if (historyTabs.length === 0) {
    return null
  }
  return (
    <>
      {historyTabs.map((tab) => (
        <HistoryChatOverlaySlot
          key={tab.id}
          tab={tab}
          groupId={tab.groupId}
          isActive={Boolean(isWorktreeActive && groupActiveTabById.get(tab.groupId) === tab.id)}
          isFocusedGroup={Boolean(
            isWorktreeActive &&
            groupActiveTabById.get(tab.groupId) === tab.id &&
            tab.groupId === activeGroupId
          )}
          onFocusOwningGroup={focusOwningGroup}
        />
      ))}
    </>
  )
})

export default AiVaultSessionHistoryChatLayer
