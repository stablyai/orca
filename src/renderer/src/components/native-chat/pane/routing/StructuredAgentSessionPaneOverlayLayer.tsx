import { Activity, memo, useCallback, useId, useLayoutEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Tab, TabGroup } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { useAppStore } from '@/store'
import { useWindowBackdropActive } from '@/app-shell/appearance/window-backdrop'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { ActivityPortalContainer } from '@/components/ui/activity-portal-container'
import { RetainedPaneHost } from '../../../tab-group/retained-pane/RetainedPaneHost'
import NativeChatView from '../../NativeChatView'
import { BotGroupChat } from '../../../bots/BotGroupChat'
import {
  NativeChatComposerEditorOwner,
  releaseNativeChatComposerEditors
} from '../../composer/editor/native-chat-composer-editor-owner'
import { NativeChatHostOutageOwner } from '../../host-access/native-chat-host-outage-owner'
import { NativeChatPaneLifetime } from '../ownership/native-chat-pane-lifetime'
import { isStructuredTab } from '../../../../../../shared/agent-session/view/structured-agent-session-tab'
import {
  NativeChatViewTabContext,
  openNativeChatViewTabs,
  releaseNativeChatViewTabs
} from '../ownership/native-chat-view-memory'
import { chatViewRetention, useRetainedChatViewKey } from './native-chat-view-retention'
import { forgetNativeChatAsyncSkipsForTabs } from '../../prompts/use-native-chat-async-questions'

/** A closed chat tab's place, kept editor, view state and kept skips end with it. */
function releaseClosedChatTabs(closed: ReadonlySet<string>): void {
  chatViewRetention.forget(closed)
  releaseNativeChatComposerEditors(closed)
  releaseNativeChatViewTabs(closed)
  forgetNativeChatAsyncSkipsForTabs(closed)
}

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
  preparingHandoff,
  hasSplitGroups,
  onFocusOwningGroup
}: {
  tab: StructuredAgentSessionTab
  groupId: string | undefined
  isActive: boolean
  isFocusedGroup: boolean
  preparingHandoff: boolean
  hasSplitGroups: boolean
  onFocusOwningGroup: ((groupId: string) => void) | undefined
}): React.JSX.Element | null {
  // Resolve from the tab’s recorded host because workspace ids can collide across hosts.
  const owner = useAppStore((state) => structuredAgentSessionOwnerForTab(state, tab))
  const target = useMemo(() => structuredAgentSessionTargetForHost(owner), [owner])
  const effectsConnected = isActive || preparingHandoff
  const viewTab = useMemo(
    () => ({ tabId: tab.id, worktreeId: tab.worktreeId }),
    [tab.id, tab.worktreeId]
  )
  const backdropActive = useWindowBackdropActive()
  if (!target) {
    return null
  }
  return (
    <RetainedPaneHost
      groupId={groupId}
      isVisible={isActive}
      // Why not over a backdrop: dimming the translucent chat also dims its text.
      dimmed={hasSplitGroups && !isFocusedGroup && !backdropActive}
      data-structured-agent-session-overlay-tab-id={tab.id}
      onFocusOwningGroup={onFocusOwningGroup}
    >
      <NativeChatViewTabContext value={viewTab}>
        <NativeChatPaneLifetime key={`${owner}:${tab.entityId}`} isVisible={effectsConnected}>
          <NativeChatHostOutageOwner target={target}>
            <NativeChatComposerEditorOwner viewTab={viewTab}>
              <ActivityPortalContainer visible={isActive}>
                <Activity mode={effectsConnected ? 'visible' : 'hidden'}>
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
                </Activity>
              </ActivityPortalContainer>
            </NativeChatComposerEditorOwner>
          </NativeChatHostOutageOwner>
        </NativeChatPaneLifetime>
      </NativeChatViewTabContext>
    </RetainedPaneHost>
  )
})

/** A bot group's room: retained like a chat so switching tabs never remounts it. */
const RoomOverlaySlot = memo(function RoomOverlaySlot({
  tab,
  isActive,
  isFocusedGroup,
  hasSplitGroups,
  onFocusOwningGroup
}: {
  tab: Tab
  isActive: boolean
  isFocusedGroup: boolean
  hasSplitGroups: boolean
  onFocusOwningGroup: (groupId: string) => void
}): React.JSX.Element {
  const backdropActive = useWindowBackdropActive()
  return (
    <RetainedPaneHost
      groupId={tab.groupId}
      isVisible={isActive}
      dimmed={hasSplitGroups && !isFocusedGroup && !backdropActive}
      data-room-overlay-tab-id={tab.id}
      onFocusOwningGroup={onFocusOwningGroup}
    >
      <BotGroupChat
        roomId={tab.entityId}
        tabId={tab.id}
        isVisible={isActive}
        isFocusedGroup={isFocusedGroup}
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
    const { unifiedTabs, groups, activeGroupId, preparingHandoff } = useAppStore(
      useShallow((state) => ({
        unifiedTabs: state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_UNIFIED_TABS,
        groups: state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS,
        activeGroupId: state.activeGroupIdByWorktree[worktreeId],
        preparingHandoff: Boolean(
          state.activeView === 'terminal' &&
          state.activePendingCreationId &&
          state.pendingWorktreeCreations[state.activePendingCreationId]?.worktreeId ===
            worktreeId &&
          state.pendingWorktreeCreations[state.activePendingCreationId]?.chatInputHandedOff
        )
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
    const roomTabs = useMemo(
      () => unifiedTabs.filter((tab) => tab.contentType === 'room'),
      [unifiedTabs]
    )
    const isActive = (tab: Tab) =>
      Boolean(isWorktreeActive && groupActiveTabById.get(tab.groupId) === tab.id)
    const layerId = useId()
    const tabIndexById = useMemo(
      () => new Map(structuredTabs.map((tab, index) => [tab.id, index] as const)),
      [structuredTabs]
    )
    // Why: walk groups and the few retained chats, not every tab: an eviction re-renders background layers.
    const shownKey =
      isWorktreeActive || preparingHandoff
        ? groups
            .map((group) => group.activeTabId)
            .filter((id): id is string => id !== null && tabIndexById.has(id))
            .join('\n')
        : ''
    useLayoutEffect(() => {
      chatViewRetention.show(layerId, shownKey ? shownKey.split('\n') : [])
    }, [layerId, shownKey])
    useLayoutEffect(() => () => chatViewRetention.show(layerId, []), [layerId])
    const ownedTabIds = useMemo(() => new Set(tabIndexById.keys()), [tabIndexById])
    const ownedTabIdsRef = useRef<ReadonlySet<string>>(new Set())
    useLayoutEffect(() => {
      const closed = new Set([...ownedTabIdsRef.current].filter((id) => !ownedTabIds.has(id)))
      ownedTabIdsRef.current = ownedTabIds
      openNativeChatViewTabs(ownedTabIds)
      if (closed.size > 0) {
        releaseClosedChatTabs(closed)
      }
    }, [ownedTabIds])
    // A removed workspace unmounts this layer without a tab close; tabs gone from the store are closed.
    useLayoutEffect(
      () => () => {
        const live = new Set(
          (useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
        )
        const closed = new Set([...ownedTabIdsRef.current].filter((id) => !live.has(id)))
        if (closed.size > 0) {
          releaseClosedChatTabs(closed)
        }
      },
      [worktreeId]
    )
    // Why: only shown chats and a few recently shown ones stay mounted, so memory doesn't grow with chats visited.
    const retainedKey = useRetainedChatViewKey(ownedTabIds)
    const mountedTabs = [...new Set([...shownKey.split('\n'), ...retainedKey.split('\n')])]
      .map((id) => tabIndexById.get(id))
      .filter((index): index is number => index !== undefined)
      .sort((a, b) => a - b)
      .map((index) => structuredTabs[index]!)

    return (
      <>
        {mountedTabs.map((tab) => (
          <StructuredAgentSessionOverlaySlot
            key={tab.id}
            tab={tab}
            groupId={tab.groupId}
            isActive={Boolean(isWorktreeActive && groupActiveTabById.get(tab.groupId) === tab.id)}
            preparingHandoff={preparingHandoff && groupActiveTabById.get(tab.groupId) === tab.id}
            isFocusedGroup={Boolean(
              isWorktreeActive &&
              groupActiveTabById.get(tab.groupId) === tab.id &&
              tab.groupId === activeGroupId
            )}
            hasSplitGroups={groups.length > 1}
            onFocusOwningGroup={focusOwningGroup}
          />
        ))}
        {roomTabs.map((tab) => (
          <RoomOverlaySlot
            key={tab.id}
            tab={tab}
            isActive={isActive(tab)}
            isFocusedGroup={isActive(tab) && tab.groupId === activeGroupId}
            hasSplitGroups={groups.length > 1}
            onFocusOwningGroup={focusOwningGroup}
          />
        ))}
      </>
    )
  }
)

export default StructuredAgentSessionPaneOverlayLayer
