import type { KeybindingActionId, KeybindingOverrides } from '../../../shared/keybindings'
import type { TuiAgent } from '../../../shared/tui-agent'
import { useAppStore } from '../store'
import {
  getAgentDetectionTargetKeyForWorktree,
  parseAgentDetectionTargetKey
} from '../hooks/useAgentDetectionTarget'
import { selectDetectedAgentIds, type AgentDetectionTarget } from '../hooks/useDetectedAgents'
import { getConnectionId } from '../lib/connection-context'
import { listBoundAgentTabActions, resolveDefaultAgentForNewTab } from '@/lib/agent-tab-shortcuts'

export type TerminalAgentTabShortcut = {
  actionId: KeybindingActionId | null
  agent: TuiAgent | null
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
    return {
      actionId: 'tab.newAgent',
      agent: resolveDefaultAgentForNewTab({
        defaultTuiAgent: state.settings?.defaultTuiAgent,
        detectedAgentIds: selectDetectedAgentIds(
          state,
          resolveDetectionTarget(state, activeWorktreeId)
        ),
        disabledTuiAgents: state.settings?.disabledTuiAgents
      })
    }
  }
  for (const bound of listBoundAgentTabActions(keybindings, state.settings?.disabledTuiAgents)) {
    if (matchShortcut(bound.actionId)) {
      return { actionId: bound.actionId, agent: bound.agent }
    }
  }
  return { actionId: null, agent: null }
}

// Why: same host resolution as the tab bar, so SSH, paired runtimes and the floating panel's native
// host each read their own detection list. While that resolution is pending (hydration, mixed
// local/SSH folder), keep the pre-existing connection-based guess, which matches terminal routing.
function resolveDetectionTarget(
  state: ReturnType<typeof useAppStore.getState>,
  worktreeId: string
): AgentDetectionTarget {
  const resolved = parseAgentDetectionTargetKey(
    getAgentDetectionTargetKeyForWorktree(state, worktreeId)
  )
  if (resolved) {
    return resolved
  }
  const connectionId = getConnectionId(worktreeId)
  return typeof connectionId === 'string' ? { kind: 'ssh', connectionId } : { kind: 'local' }
}
