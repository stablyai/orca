import type { KeybindingActionId, KeybindingOverrides } from '../../../shared/keybindings'
import type { TuiAgent } from '../../../shared/tui-agent'
import { useAppStore } from '../store'
import { readDetectedAgentsForWorktree } from '@/lib/agent-detection-target-inventory'
import {
  listBoundAgentTabActions,
  resolveDefaultAgentForNewTab,
  resolveDefaultAgentForWorktreeNewTab
} from '@/lib/agent-tab-shortcuts'

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
  if (matchShortcut('tab.newAgent')) {
    const agent = resolveDefaultAgentForNewTab({
      defaultTuiAgent: state.settings?.defaultTuiAgent,
      detectedAgentIds: readDetectedAgentsForWorktree(state, activeWorktreeId),
      disabledTuiAgents: state.settings?.disabledTuiAgents
    })
    // Why: the cached list is empty until the host's probe lands (e.g. a paired server's
    // workspace right after it opens); ask that host instead of reporting no agent.
    return agent
      ? { actionId: 'tab.newAgent', agent }
      : {
          actionId: 'tab.newAgent',
          agent: null,
          pendingAgent: resolveDefaultAgentForWorktreeNewTab(useAppStore.getState, activeWorktreeId)
        }
  }
  for (const bound of listBoundAgentTabActions(keybindings, state.settings?.disabledTuiAgents)) {
    if (matchShortcut(bound.actionId)) {
      return { actionId: bound.actionId, agent: bound.agent }
    }
  }
  return { actionId: null, agent: null }
}
