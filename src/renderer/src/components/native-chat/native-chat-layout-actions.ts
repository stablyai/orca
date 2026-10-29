import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { captureNativeChatComposerFocusIntent } from '@/components/native-chat/use-native-chat-composer-reveal-focus'
import { requestActiveTerminalPaneSplit } from '@/components/tab-bar/request-active-terminal-pane-split'
import type { NativeChatSplitDirection } from './native-chat-split-shortcut'

export type NativeChatSplitTarget =
  | { kind: 'terminal-pane'; terminalTabId: string }
  | { kind: 'workspace-tab'; unifiedTabId: string; groupId: string }

export function resolveActiveNativeChatSplitTarget(
  state: Pick<AppState, 'groupsByWorktree' | 'unifiedTabsByWorktree'>,
  worktreeId: string | null,
  groupId: string | null
): NativeChatSplitTarget | null {
  if (!worktreeId || !groupId) {
    return null
  }
  const group = (state.groupsByWorktree?.[worktreeId] ?? []).find((entry) => entry.id === groupId)
  const tab = (state.unifiedTabsByWorktree?.[worktreeId] ?? []).find(
    (entry) => entry.id === group?.activeTabId && entry.groupId === groupId
  )
  if (tab?.contentType === 'agent-session') {
    return { kind: 'workspace-tab', unifiedTabId: tab.id, groupId }
  }
  if (tab?.contentType === 'terminal' && tab.viewMode === 'chat') {
    return { kind: 'terminal-pane', terminalTabId: tab.entityId }
  }
  return null
}

export function canRunNativeChatSplitTarget(
  state: Pick<AppState, 'groupsByWorktree' | 'unifiedTabsByWorktree'>,
  target: NativeChatSplitTarget | null
): boolean {
  if (!target) {
    return false
  }
  return target.kind === 'terminal-pane' || findSplitSource(state, target) !== null
}

function findSplitSource(
  state: Pick<AppState, 'groupsByWorktree' | 'unifiedTabsByWorktree'>,
  target: Extract<NativeChatSplitTarget, { kind: 'workspace-tab' }>
) {
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    const tab = tabs.find(
      (candidate) => candidate.id === target.unifiedTabId && candidate.groupId === target.groupId
    )
    if (
      tab?.contentType === 'agent-session' &&
      isTuiAgent(tab.agentSessionAgent) &&
      state.groupsByWorktree[worktreeId]?.some((group) => group.id === target.groupId)
    ) {
      return { tab, worktreeId, agent: tab.agentSessionAgent }
    }
  }
  return null
}

export function runNativeChatSplitTarget(
  target: NativeChatSplitTarget,
  direction: NativeChatSplitDirection
): boolean {
  if (target.kind === 'terminal-pane') {
    requestActiveTerminalPaneSplit({
      tabId: target.terminalTabId,
      direction: direction === 'right' ? 'vertical' : 'horizontal'
    })
    return true
  }
  // Captured first so focus follows this action into the new chat's composer.
  const focusIntent = captureNativeChatComposerFocusIntent()
  const state = useAppStore.getState()
  const source = findSplitSource(state, target)
  const groupId = source
    ? state.createEmptySplitGroup(source.worktreeId, target.groupId, direction)
    : null
  if (!source || !groupId) {
    focusIntent.cancel()
    return false
  }
  const closePane = (): void => {
    useAppStore.getState().closeEmptyGroup(source.worktreeId, groupId)
  }
  // Same launch as New Chat, so the fresh chat opens at once in the new pane.
  const result = launchAgentInNewTab({
    requestId: newAgentLaunchRequestId(),
    focusIntent,
    requestedSurface: 'chat',
    selectedExecutionHostId: source.tab.executionHostId,
    agent: source.agent,
    worktreeId: source.worktreeId,
    groupId
  })
  if (!result) {
    closePane()
    toast.error(
      translate(
        'auto.components.tab.bar.QuickLaunchButton.465e432ef1',
        'Could not build launch command for {{value0}}.',
        { value0: getAgentLabel(source.agent) }
      )
    )
    return true
  }
  // Settlement cleanup preserves any pane that currently contains a tab.
  void result.structuredSettlement?.then(closePane, closePane)
  return true
}

export function runActiveNativeChatSplit(
  worktreeId: string | null,
  groupId: string | null,
  direction: NativeChatSplitDirection
): boolean {
  const state = useAppStore.getState()
  const target = resolveActiveNativeChatSplitTarget(state, worktreeId, groupId)
  return target ? runNativeChatSplitTarget(target, direction) : false
}
