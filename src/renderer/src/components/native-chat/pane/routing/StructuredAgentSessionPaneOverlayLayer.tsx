import { Activity, memo, useCallback, useMemo } from 'react'
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
import { NativeChatComposerEditorOwner } from '../../composer/editor/native-chat-composer-editor-owner'
import { NativeChatHostOutageOwner } from '../../host-access/native-chat-host-outage-owner'
import { NativeChatPaneLifetime } from '../ownership/native-chat-pane-lifetime'
import { isStructuredTab } from '../../../../../../shared/agent-session/view/structured-agent-session-tab'

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
  preparingHandoff,
  hasSplitGroups,
  onFocusOwningGroup
}: {
  tab: StructuredAgentSessionTab
  groupId: string | undefined
  isActive: boolean
  isFocusedGroup: boolean
  /** The workspace's own focused split, regardless of which grid view cell holds the keyboard. */
  isFocusedSplit: boolean
  preparingHandoff: boolean
  hasSplitGroups: boolean
  onFocusOwningGroup: ((groupId: string) => void) | undefined
}): React.JSX.Element | null {
  // Resolve from the tab’s recorded host because workspace ids can collide across hosts.
  const owner = useAppStore((state) => structuredAgentSessionOwnerForTab(state, tab))
  const target = useMemo(() => structuredAgentSessionTargetForHost(owner), [owner])
  const effectsConnected = isActive || preparingHandoff
  const backdropActive = useWindowBackdropActive()
  if (!target) {
    return null
  }
  return (
    <RetainedPaneHost
      groupId={groupId}
      isVisible={isActive}
      // Why not over a backdrop: dimming the translucent chat also dims its text.
      dimmed={hasSplitGroups && !isFocusedSplit && !backdropActive}
      data-structured-agent-session-overlay-tab-id={tab.id}
      onFocusOwningGroup={onFocusOwningGroup}
    >
      <NativeChatPaneLifetime key={`${owner}:${tab.entityId}`} isVisible={effectsConnected}>
        <NativeChatHostOutageOwner target={target}>
          <NativeChatComposerEditorOwner>
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
              preparingHandoff={preparingHandoff && groupActiveTabById.get(tab.groupId) === tab.id}
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
