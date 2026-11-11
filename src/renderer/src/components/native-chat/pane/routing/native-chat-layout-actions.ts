import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { requestActiveTerminalPaneSplit } from '@/components/tab-bar/request-active-terminal-pane-split'
import { openNewTerminalTabInWorkspace } from '@/store/terminals/terminal-active-workspace-creation'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import type { NativeChatSplitDirection } from './native-chat-pane-shortcut'

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
      state.groupsByWorktree[worktreeId]?.some((group) => group.id === target.groupId)
    ) {
      return { tab, worktreeId }
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
  const source = findSplitSource(useAppStore.getState(), target)
  if (!source) {
    return false
  }
  if (source.worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    // The floating panel is a scratch terminal workspace with its own empty state.
    void openNewTerminalTabInWorkspace(useAppStore.getState, source.worktreeId, target.groupId, {
      sourceGroupId: target.groupId,
      splitDirection: direction
    }).catch(() => {
      toast.error(
        translate(
          'auto.store.slices.worktrees.localBaseRefUnshallowFailed',
          'Could not open a terminal for this workspace'
        )
      )
    })
  } else {
    // The new pane shows the split landing so the user picks what opens there.
    useAppStore
      .getState()
      .createEmptySplitGroup(source.worktreeId, target.groupId, direction, { landing: true })
  }
  useAppStore.getState().recordFeatureInteraction('tab-splits')
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
