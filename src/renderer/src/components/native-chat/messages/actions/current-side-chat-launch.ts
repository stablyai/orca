import { isTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import { afterPendingEntityTabs } from '@/runtime/workspace-layout/intents/layout-owner-pending-tabs'
import { useAppStore } from '@/store'
import { launchNativeChatFork, nativeChatForkSurfaceAddress } from './native-chat-fork-launch'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/native-chat/status/structured-agent-session-status-feed'
import { getTabGroupPanelRect } from '../../../tab-group/drag/tab-group-panel-split-target'
import {
  moveTabToGroup,
  moveTabToNewPaneColumn
} from '../../../tab-bar/pane-actions/tab-move-to-pane-column'
import { readStructuredAgentLaunchRecords } from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import { structuredAgentSessionTabId } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'

export function isCurrentSideChat(tab: Tab): boolean {
  if (tab.contentType !== 'agent-session') {
    return false
  }
  const target = structuredAgentSessionTargetForHost(
    structuredAgentSessionOwnerForTab(useAppStore.getState(), tab)
  )
  return (
    !!target &&
    !!getStructuredAgentSessionStatusFeed(target).getNamingSnapshot().get(tab.entityId)?.sideChat
  )
}

function findSideChatGroup(worktreeId: string) {
  const state = useAppStore.getState()
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const sideIds = new Set(tabs.filter(isCurrentSideChat).map((tab) => tab.id))
  const pendingGroups = new Set<string>()
  for (const record of readStructuredAgentLaunchRecords()) {
    if (
      record.lifecycle !== 'failed' &&
      record.forkFrom?.current &&
      record.surfaceAddress?.worktreeId === worktreeId
    ) {
      sideIds.add(record.tabId ?? structuredAgentSessionTabId(record.sessionId))
      if (record.surfaceAddress.targetGroupId) {
        pendingGroups.add(record.surfaceAddress.targetGroupId)
      }
    }
  }
  return groups.find((group) =>
    group.tabOrder.length
      ? group.tabOrder.every((id) => sideIds.has(id))
      : pendingGroups.has(group.id)
  )
}

function prepareSideChatPane(worktreeId: string, sourceTabId: string) {
  const state = useAppStore.getState()
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const source = groups.find((group) => group.tabOrder.includes(sourceTabId))
  if (!source) {
    return undefined
  }
  const rect = getTabGroupPanelRect(source.id, worktreeId)
  const existing = findSideChatGroup(worktreeId)
  const groupId =
    existing?.id ??
    state.createEmptySplitGroup(
      worktreeId,
      source.id,
      rect && rect.width < rect.height ? 'down' : 'right',
      { activate: false }
    )
  if (!groupId) {
    return undefined
  }
  return { groupId, created: !existing }
}

function moveSideChatsInto(worktreeId: string, groupId: string): void {
  const state = useAppStore.getState()
  let index =
    state.groupsByWorktree[worktreeId]?.find((group) => group.id === groupId)?.tabOrder.length ?? 0
  for (const tab of useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []) {
    if (isCurrentSideChat(tab) && tab.groupId !== groupId) {
      moveTabToGroup({ worktreeId, unifiedTabId: tab.id, groupId, index: index++ })
    }
  }
}

const grouping = new Set<string>()

export function groupCurrentSideChats(worktreeId: string): void {
  if (grouping.has(worktreeId)) {
    return
  }
  const state = useAppStore.getState()
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const existing = findSideChatGroup(worktreeId)
  if (existing) {
    moveSideChatsInto(worktreeId, existing.id)
    return
  }
  const source = tabs.find(isCurrentSideChat)
  if (!source) {
    return
  }
  const rect = getTabGroupPanelRect(source.groupId, worktreeId)
  grouping.add(worktreeId)
  const finish = () => {
    clearTimeout(expiry)
    unsubscribe()
    grouping.delete(worktreeId)
  }
  const unsubscribe = useAppStore.subscribe((next) => {
    const moved = next.unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.id === source.id)
    if (!moved || next.activeWorktreeId !== worktreeId) {
      finish()
    } else if (moved.groupId !== source.groupId) {
      finish()
      moveSideChatsInto(worktreeId, moved.groupId)
    }
  })
  const expiry = setTimeout(finish, 30_000)
  const moved = moveTabToNewPaneColumn({
    worktreeId,
    unifiedTabId: source.id,
    groupId: source.groupId,
    direction: rect && rect.width < rect.height ? 'down' : 'right',
    completion: { refused: finish, moveHere: (move) => move() }
  })
  if (!moved) {
    finish()
  }
}

const pending = new Map<string, Promise<void>>()

export function openCurrentSideChat(worktreeId: string, tabId: string): Promise<void> {
  const key = JSON.stringify([worktreeId, tabId])
  const existing = pending.get(key)
  if (existing) {
    return existing
  }
  const opening = open(worktreeId, tabId).finally(() => {
    if (pending.get(key) === opening) {
      pending.delete(key)
    }
  })
  pending.set(key, opening)
  return opening
}

async function open(worktreeId: string, tabId: string): Promise<void> {
  const state = useAppStore.getState()
  const tab = state.unifiedTabsByWorktree[worktreeId]?.find((entry) => entry.id === tabId)
  if (
    tab?.contentType !== 'agent-session' ||
    !tab.agentSessionAgent ||
    !isTuiAgent(tab.agentSessionAgent)
  ) {
    return
  }
  const host = structuredAgentSessionOwnerForTab(state, tab)
  const target = structuredAgentSessionTargetForHost(host)
  if (!target) {
    return
  }
  const destination =
    state.settings?.nativeChatSideChatPane === true
      ? prepareSideChatPane(worktreeId, tabId)
      : undefined
  if (state.settings?.nativeChatSideChatPane === true && !destination) {
    return
  }
  try {
    const outcome = await launchNativeChatFork({
      agent: tab.agentSessionAgent,
      worktreeId,
      target,
      forkFrom: { sessionId: tab.entityId, current: true, permission: 'inherit' },
      forkRequiresInheritedOriginal: false,
      beforeCreate: () => {
        const next = useAppStore.getState()
        const source = next.unifiedTabsByWorktree[worktreeId]?.find((entry) => entry.id === tabId)
        return (
          source?.entityId === tab.entityId &&
          structuredAgentSessionOwnerForTab(next, source) === host
        )
      },
      surfaceAddress: destination
        ? { worktreeId, targetGroupId: destination.groupId, precedingTabIds: [] }
        : nativeChatForkSurfaceAddress(worktreeId, tabId)
    })
    if (outcome.chat && destination) {
      const childSessionId = outcome.chat.sessionId
      afterPendingEntityTabs(worktreeId, childSessionId, () => {
        const child = useAppStore
          .getState()
          .unifiedTabsByWorktree[worktreeId]?.find(
            (tab) => tab.contentType === 'agent-session' && tab.entityId === childSessionId
          )
        if (child?.groupId === destination.groupId) {
          moveSideChatsInto(worktreeId, destination.groupId)
        }
      })
    }
  } finally {
    if (
      destination?.created &&
      !readStructuredAgentLaunchRecords().some(
        (record) =>
          record.lifecycle !== 'failed' &&
          record.surfaceAddress?.worktreeId === worktreeId &&
          record.surfaceAddress.targetGroupId === destination.groupId
      )
    ) {
      useAppStore.getState().closeEmptyGroup(worktreeId, destination.groupId)
    }
  }
}
