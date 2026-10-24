import { memo, useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import { useAppStore } from '@/store'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import { RetainedPaneHost } from '../tab-group/RetainedPaneHost'
import NativeChatView from './NativeChatView'
import { isStructuredTab } from '../../../../shared/structured-agent-session-tab'

type StructuredAgentSessionTab = Tab & {
  contentType: 'agent-session'
  agentSessionAgent: NonNullable<Tab['agentSessionAgent']>
}

const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_GROUPS: readonly TabGroup[] = []

const StructuredAgentSessionOverlaySlot = memo(function StructuredAgentSessionOverlaySlot({
  tab,
  groupId,
  isActive,
  isFocusedGroup,
  isFocusedSplit,
  hasSplitGroups,
  onFocusOwningGroup
}: {
  tab: StructuredAgentSessionTab
  groupId: string | undefined
  isActive: boolean
  isFocusedGroup: boolean
  /** The workspace's own focused split, regardless of which grid view cell holds the keyboard. */
  isFocusedSplit: boolean
  hasSplitGroups: boolean
  onFocusOwningGroup: ((groupId: string) => void) | undefined
}): React.JSX.Element | null {
  // Each chat is read from the host recorded on its tab, never from its workspace id, which two
  // hosts can share.
  const owner = useAppStore((state) => structuredAgentSessionOwnerForTab(state, tab))
  const target = useMemo(() => structuredAgentSessionTargetForHost(owner), [owner])
  if (!target) {
    return null
  }
  return (
    <RetainedPaneHost
      groupId={groupId}
      isVisible={isActive}
      dimmed={hasSplitGroups && !isFocusedSplit}
      data-structured-agent-session-overlay-tab-id={tab.id}
      onFocusOwningGroup={onFocusOwningGroup}
    >
      <NativeChatView
        mode="structured"
        tabId={tab.id}
        groupId={groupId}
        sessionId={tab.entityId}
        agent={tab.agentSessionAgent}
        isVisible={isActive}
        isFocusedGroup={isFocusedGroup}
        target={target}
      />
    </RetainedPaneHost>
  )
})

const StructuredAgentSessionPaneOverlayLayer = memo(
  function StructuredAgentSessionPaneOverlayLayer({
    worktreeId,
    isWorktreeActive,
    isWorktreeFocused = isWorktreeActive
  }: {
    worktreeId: string
    isWorktreeActive: boolean
    isWorktreeFocused?: boolean
  }): React.JSX.Element {
    const { unifiedTabs, groups, activeGroupId } = useAppStore(
      useShallow((state) => ({
        unifiedTabs: state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_UNIFIED_TABS,
        groups: state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS,
        activeGroupId: state.activeGroupIdByWorktree[worktreeId]
      }))
    )
    const focusGroup = useAppStore((state) => state.focusGroup)
    const focusOwningGroup = useCallback(
      (groupId: string) => focusGroup(worktreeId, groupId),
      [focusGroup, worktreeId]
    )
    const groupActiveTabById = useMemo(
      () => new Map(groups.map((group) => [group.id, group.activeTabId] as const)),
      [groups]
    )
    const structuredTabs = useMemo(
      () => unifiedTabs.filter((tab): tab is StructuredAgentSessionTab => isStructuredTab(tab)),
      [unifiedTabs]
    )

    return (
      <>
        {structuredTabs.map((tab) => {
          const isActive = Boolean(
            isWorktreeActive && groupActiveTabById.get(tab.groupId) === tab.id
          )
          const isFocusedSplit = isActive && tab.groupId === activeGroupId
          return (
            <StructuredAgentSessionOverlaySlot
              key={tab.id}
              tab={tab}
              groupId={tab.groupId}
              isActive={isActive}
              isFocusedGroup={isFocusedSplit && isWorktreeFocused}
              isFocusedSplit={isFocusedSplit}
              hasSplitGroups={groups.length > 1}
              onFocusOwningGroup={focusOwningGroup}
            />
          )
        })}
      </>
    )
  }
)

export default StructuredAgentSessionPaneOverlayLayer
