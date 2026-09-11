import { memo, useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useStructuredTabOwnerBinding } from '@/runtime/structured-tab-owner'
import { RetainedPaneHost } from '../tab-group/RetainedPaneHost'
import NativeChatView from './NativeChatView'

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
  fallbackRuntimeEnvironmentId,
  onFocusOwningGroup
}: {
  tab: StructuredAgentSessionTab
  groupId: string | undefined
  isActive: boolean
  isFocusedGroup: boolean
  fallbackRuntimeEnvironmentId: string | null
  onFocusOwningGroup: ((groupId: string) => void) | undefined
}): React.JSX.Element {
  // The tab's stamp, never the worktree's current runtime owner: an open pane must keep addressing
  // the host its session was launched on even after the worktree is remapped.
  const binding = useStructuredTabOwnerBinding(tab, fallbackRuntimeEnvironmentId)
  return (
    <RetainedPaneHost
      groupId={groupId}
      isVisible={isActive}
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
        target={binding.target}
        ownerPairingRevision={
          binding.owner.kind === 'environment' ? binding.owner.pairingRevision : undefined
        }
        ownerPairingStale={binding.ownerPairingStale}
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
    const { unifiedTabs, groups, runtimeEnvironmentId, activeGroupId } = useAppStore(
      useShallow((state) => ({
        unifiedTabs: state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_UNIFIED_TABS,
        groups: state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS,
        runtimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId),
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
      () =>
        unifiedTabs.filter(
          (tab): tab is StructuredAgentSessionTab =>
            tab.contentType === 'agent-session' &&
            isAgentSessionHandleProvider(tab.agentSessionAgent)
        ),
      [unifiedTabs]
    )

    return (
      <>
        {structuredTabs.map((tab) => (
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
            fallbackRuntimeEnvironmentId={runtimeEnvironmentId}
            onFocusOwningGroup={focusOwningGroup}
          />
        ))}
      </>
    )
  }
)

export default StructuredAgentSessionPaneOverlayLayer
