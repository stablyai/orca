import type { KeybindingActionId, KeybindingOverrides } from '../../../shared/keybindings'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { useAppStore } from '../store'
import type { AppState } from '../store/types'
import { readDetectedAgentsForWorktree } from '@/lib/agent-session/launch/inventory/agent-detection-target-inventory'
import { readAgentLaunchPreferencesForWorktree } from '@/runtime/agent-launch-settings/use-host-agent-launch-preferences'
import {
  listBoundAgentTabActions,
  resolveDefaultAgentForNewTab,
  resolveDefaultAgentForWorktreeNewTab
} from '@/lib/agent-session/launch/shortcuts/agent-tab-shortcuts'
import { chosenAgentChatUnlearned } from '@/lib/host-chat-program'
import { worktreeLaunchWorkspace } from '@/lib/agent-session/launch/routing/agent-launch-route-input'

export type TerminalAgentTabShortcut = {
  actionId: KeybindingActionId | null
  agent: TuiAgent | null
  /** Set when the cached list has no usable agent; settles once the workspace's host answers. */
  pendingAgent?: Promise<TuiAgent | null>
}

export function readAgentTabShortcutActions(
  activeWorktreeId: string,
  keybindings: KeybindingOverrides
) {
  const state = useAppStore.getState()
  const preferences = readAgentLaunchPreferencesForWorktree(state, activeWorktreeId)
  return [
    { actionId: 'tab.newTerminal' as const, agent: null },
    {
      actionId: 'tab.newAgent' as const,
      get agent() {
        return readNewAgentTabDefault(state, activeWorktreeId)
      }
    },
    ...listBoundAgentTabActions(keybindings, preferences.disabledTuiAgents)
  ]
}

/** The agent New Agent opens right now, or null while the workspace's host hasn't answered. */
export function readNewAgentTabDefault(state: AppState, worktreeId: string): TuiAgent | null {
  const preferences = readAgentLaunchPreferencesForWorktree(state, worktreeId)
  const detectedAgentIds = readDetectedAgentsForWorktree(state, worktreeId)
  const agent = resolveDefaultAgentForNewTab({
    ...preferences,
    detectedAgentIds,
    chatIn: { store: state, worktreeId }
  })
  return agent &&
    !chosenAgentChatUnlearned(
      state,
      preferences.defaultTuiAgent,
      detectedAgentIds,
      worktreeLaunchWorkspace(worktreeId)
    )
    ? agent
    : null
}

export function resolveAgentTabShortcutAction(
  actions: ReturnType<typeof readAgentTabShortcutActions>,
  matchShortcut: (actionId: KeybindingActionId) => boolean
) {
  return actions.find(({ actionId }) => matchShortcut(actionId))
}

export function resolveTerminalAgentTabShortcut({
  activeWorktreeId,
  keybindings,
  matchShortcut,
  includeTerminal = false
}: {
  activeWorktreeId: string
  keybindings: KeybindingOverrides
  matchShortcut: (actionId: KeybindingActionId) => boolean
  includeTerminal?: boolean
}): TerminalAgentTabShortcut {
  const action = resolveAgentTabShortcutAction(
    readAgentTabShortcutActions(activeWorktreeId, keybindings),
    (actionId) => (includeTerminal || actionId !== 'tab.newTerminal') && matchShortcut(actionId)
  )
  if (!action) {
    return { actionId: null, agent: null }
  }
  const { actionId, agent } = action
  return actionId === 'tab.newAgent' && !agent
    ? {
        actionId,
        agent,
        pendingAgent: resolveDefaultAgentForWorktreeNewTab(useAppStore.getState, activeWorktreeId)
      }
    : { actionId, agent }
}
