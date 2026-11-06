import { useAppStore } from '@/store'
import { pendingTabGroupId } from '@/runtime/layout-owner-pending-tabs'
import { structuredChatTabIsSideChat } from '@/runtime/structured-chat-tab-side-chat'
import { structuredAgentSessionTabId } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { readStructuredAgentLaunchRecords } from './agent-session/launch/structured-agent-session-launch-persistence'
import { sideChatOnlyGroup } from '@/components/tab-group/side-chat-pane-placement'
import { getTabGroupPanelRect } from '@/components/tab-group/tab-group-panel-split-target'
import type { PreparedProvisionalTab } from './agent-session/structured-agent-session-provisional-tab'

export function prepareSideChatPane(
  worktreeId: string,
  sourceTabId: string
): PreparedProvisionalTab | null | undefined {
  const state = useAppStore.getState()
  if (state.settings?.nativeChatSideChatPane !== true) {
    return undefined
  }
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const source = tabs.find((tab) => tab.id === sourceTabId)
  const groups = state.groupsByWorktree[worktreeId] ?? []
  if (!source || !groups.some((group) => group.id === source.groupId)) {
    return null
  }
  const sideIds = new Set(
    tabs
      .filter(
        (tab) => tab.contentType === 'agent-session' && structuredChatTabIsSideChat(state, tab)
      )
      .map((tab) => tab.id)
  )
  const pendingGroups = new Set<string>()
  for (const record of readStructuredAgentLaunchRecords()) {
    if (
      record.lifecycle !== 'failed' &&
      record.sideChatOf &&
      record.surfaceAddress?.worktreeId === worktreeId
    ) {
      sideIds.add(structuredAgentSessionTabId(record.sessionId))
      if (record.surfaceAddress.targetGroupId) {
        pendingGroups.add(record.surfaceAddress.targetGroupId)
      }
    }
  }
  const existing =
    sideChatOnlyGroup(groups, sideIds) ??
    groups.find((group) => group.tabOrder.length === 0 && pendingGroups.has(group.id))
  const rect = getTabGroupPanelRect(source.groupId, worktreeId)
  const groupId =
    existing?.id ??
    state.createEmptySplitGroup(
      worktreeId,
      source.groupId,
      rect && rect.width < rect.height ? 'down' : 'right',
      { activate: false }
    )
  if (!groupId) {
    return null
  }
  return {
    targetGroupId: groupId,
    index: 0,
    release: () => {
      const stillOpening = readStructuredAgentLaunchRecords().some(
        (record) => pendingTabGroupId(structuredAgentSessionTabId(record.sessionId)) === groupId
      )
      if (!existing && !stillOpening) {
        useAppStore.getState().closeEmptyGroup(worktreeId, groupId)
      }
    }
  }
}
