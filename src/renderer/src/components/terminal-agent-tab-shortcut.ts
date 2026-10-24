import type { KeybindingActionId, KeybindingOverrides } from '../../../shared/keybindings'
import type { TuiAgent } from '../../../shared/tui-agent'
import { useAppStore } from '../store'
import { readDetectedAgentsForWorktree } from '@/lib/agent-detection-target-inventory'
import { readAgentLaunchPreferencesForWorktree } from '@/components/settings/use-host-agent-launch-preferences'
import {
  listBoundAgentTabActions,
  resolveDefaultAgentForNewTab,
  resolveDefaultAgentForWorktreeNewTab
} from '@/lib/agent-tab-shortcuts'
import { chosenAgentChatUnlearned } from '@/lib/host-chat-program'
import { worktreeLaunchWorkspace } from '@/lib/agent-launch-route-input'

export type TerminalAgentTabShortcut = {
  actionId: KeybindingActionId | null
  agent: TuiAgent | null
  /** Set when the cached list has no usable agent; settles once the workspace's host answers. */
  pendingAgent?: Promise<TuiAgent | null>
}

export function resolveTerminalAgentTabShortcut({
  activeWorktreeId,
  keybindings,
  matchShortcut
}: {
  activeWorktreeId: string
  keybindings: KeybindingOverrides
  matchShortcut: (actionId: KeybindingActionId) => boolean
}): TerminalAgentTabShortcut {
  const state = useAppStore.getState()
  const preferences = readAgentLaunchPreferencesForWorktree(state, activeWorktreeId)
  if (matchShortcut('tab.newAgent')) {
    const detectedAgentIds = readDetectedAgentsForWorktree(state, activeWorktreeId)
    const chosen = preferences.defaultTuiAgent
    const agent = resolveDefaultAgentForNewTab({
      ...preferences,
      detectedAgentIds,
      chatIn: { store: state, worktreeId: activeWorktreeId }
    })
    const workspace = worktreeLaunchWorkspace(activeWorktreeId)
    // Why: the cached list is empty until the host's probe lands (e.g. a paired server's
    // workspace right after it opens) or a chat-only default is unlearned; ask that host first.
    return agent && !chosenAgentChatUnlearned(state, chosen, detectedAgentIds, workspace)
      ? { actionId: 'tab.newAgent', agent }
      : {
          actionId: 'tab.newAgent',
          agent: null,
          pendingAgent: resolveDefaultAgentForWorktreeNewTab(useAppStore.getState, activeWorktreeId)
        }
  }
  for (const bound of listBoundAgentTabActions(keybindings, preferences.disabledTuiAgents)) {
    if (matchShortcut(bound.actionId)) {
      return { actionId: bound.actionId, agent: bound.agent }
    }
  }
  return { actionId: null, agent: null }
}
