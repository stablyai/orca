import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import { useAppStore } from '@/store'
import { useThemeBackgroundStore } from '@/store/theme-background'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import { RetainedPaneHost } from '../tab-group/RetainedPaneHost'
import NativeChatView from './NativeChatView'
import { isStructuredTab } from '../../../../shared/agent-session/view/structured-agent-session-tab'

export const STRUCTURED_CHAT_HOT_RETAIN_LIMIT = 2

type StructuredAgentSessionTab = Tab & {
  contentType: 'agent-session'
  agentSessionAgent: NonNullable<Tab['agentSessionAgent']>
}

const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_GROUPS: readonly TabGroup[] = []

export function selectRetainedStructuredTabIds(args: {
  structuredTabIds: readonly string[]
  selectedTabIds: ReadonlySet<string>
  recentTabIds: readonly string[]
  hotRetainLimit?: number
}): Set<string> {
  const limit = args.hotRetainLimit ?? STRUCTURED_CHAT_HOT_RETAIN_LIMIT
  const liveIds = new Set(args.structuredTabIds)
  const retained = new Set<string>()
  for (const id of args.selectedTabIds) {
    if (liveIds.has(id)) {
      retained.add(id)
    }
  }
  let warmInactiveCount = 0
  for (const id of args.recentTabIds) {
    if (warmInactiveCount >= limit) {
      break
    }
    if (liveIds.has(id) && !retained.has(id)) {
      retained.add(id)
      warmInactiveCount += 1
    }
  }
  for (const id of args.structuredTabIds) {
    if (warmInactiveCount >= limit) {
      break
    }
    if (!retained.has(id)) {
      retained.add(id)
      warmInactiveCount += 1
    }
  }
  return retained
}

const StructuredAgentSessionOverlaySlot = memo(function StructuredAgentSessionOverlaySlot({
  tab,
  groupId,
  isActive,
  isFocusedGroup,
  hasSplitGroups,
  onFocusOwningGroup
}: {
  tab: StructuredAgentSessionTab
  groupId: string | undefined
  isActive: boolean
  isFocusedGroup: boolean
  hasSplitGroups: boolean
  onFocusOwningGroup: ((groupId: string) => void) | undefined
}): React.JSX.Element | null {
  // Resolve from the tab’s recorded host because workspace ids can collide across hosts.
  const owner = useAppStore((state) => structuredAgentSessionOwnerForTab(state, tab))
  const target = useMemo(() => structuredAgentSessionTargetForHost(owner), [owner])
  const themeBackgroundActive = useThemeBackgroundStore((state) => state.active)
  if (!target) {
    return null
  }
  return (
    <RetainedPaneHost
      groupId={groupId}
      isVisible={isActive}
      // Why not over a theme image: the chat is translucent there, so a dim would bleed the image in.
      dimmed={hasSplitGroups && !isFocusedGroup && !themeBackgroundActive}
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
    isWorktreeActive
  }: {
    worktreeId: string
    isWorktreeActive: boolean
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
    const selectedStructuredTabIds = useMemo(() => {
      const selected = new Set<string>()
      for (const tab of structuredTabs) {
        if (groupActiveTabById.get(tab.groupId) === tab.id) {
          selected.add(tab.id)
        }
      }
      return selected
    }, [groupActiveTabById, structuredTabs])
    const [recentTabIds, setRecentTabIds] = useState<readonly string[]>([])
    useEffect(() => {
      if (selectedStructuredTabIds.size === 0) {
        return
      }
      setRecentTabIds((previous) => {
        const liveIds = new Set(structuredTabs.map((tab) => tab.id))
        const next: string[] = []
        for (const id of selectedStructuredTabIds) {
          if (liveIds.has(id) && !next.includes(id)) {
            next.push(id)
          }
        }
        for (const id of previous) {
          if (liveIds.has(id) && !next.includes(id)) {
            next.push(id)
          }
        }
        const trimmed = next.slice(
          0,
          selectedStructuredTabIds.size + STRUCTURED_CHAT_HOT_RETAIN_LIMIT
        )
        if (
          trimmed.length === previous.length &&
          trimmed.every((id, index) => id === previous[index])
        ) {
          return previous
        }
        return trimmed
      })
    }, [selectedStructuredTabIds, structuredTabs])
    const retainedTabIds = useMemo(
      () =>
        selectRetainedStructuredTabIds({
          structuredTabIds: structuredTabs.map((tab) => tab.id),
          selectedTabIds: selectedStructuredTabIds,
          recentTabIds
        }),
      [recentTabIds, selectedStructuredTabIds, structuredTabs]
    )

    return (
      <>
        {structuredTabs.map((tab) =>
          retainedTabIds.has(tab.id) ? (
            <StructuredAgentSessionOverlaySlot
              key={tab.id}
              tab={tab}
              groupId={tab.groupId}
              isActive={Boolean(isWorktreeActive && groupActiveTabById.get(tab.groupId) === tab.id)}
              isFocusedGroup={Boolean(
                isWorktreeActive &&
                groupActiveTabById.get(tab.groupId) === tab.id &&
                tab.groupId === activeGroupId
              )}
              hasSplitGroups={groups.length > 1}
              onFocusOwningGroup={focusOwningGroup}
            />
          ) : null
        )}
      </>
    )
  }
)

export default StructuredAgentSessionPaneOverlayLayer
