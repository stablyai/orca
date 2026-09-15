import type { KeybindingActionId, KeybindingOverrides } from '../../../shared/keybindings'
import type { TuiAgent } from '../../../shared/tui-agent'
import { useAppStore } from '../store'
import { getConnectionId } from '../lib/connection-context'
import { listBoundAgentTabActions, resolveDefaultAgentForNewTab } from '@/lib/agent-tab-shortcuts'
import {
  getAgentDetectionTargetKeyForWorktree,
  parseAgentDetectionTargetKey
} from '@/hooks/useAgentDetectionTarget'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

export type TerminalAgentTabShortcut = {
  actionId: KeybindingActionId | null
  agent: TuiAgent | null
}

// Why: the floating workspace is always local (never SSH/runtime-owned), so its detected agents
// live under a dedicated local context key rather than activeWorktreeId's connection. Nothing in
// the floating panel's own UI mounts useDetectedAgents for that context, so it never warms on its
// own — kick off detection here and, for this keypress, fall back to the already-populated general
// local list (same host on the platforms floating agent launches support).
function resolveFloatingDetectedAgentIds(
  state: ReturnType<typeof useAppStore.getState>
): readonly TuiAgent[] | null | undefined {
  const target = parseAgentDetectionTargetKey(
    getAgentDetectionTargetKeyForWorktree(state, FLOATING_TERMINAL_WORKTREE_ID)
  )
  if (target?.kind !== 'local' || !target.contextKey) {
    return state.detectedAgentIds
  }
  const cached = state.localDetectedAgentIdsByContext[target.contextKey]
  if (cached == null) {
    void state.ensureDetectedAgents(FLOATING_TERMINAL_WORKTREE_ID)
    return state.detectedAgentIds
  }
  return cached
}

export function resolveTerminalAgentTabShortcut({
  activeWorktreeId,
  floatingWorkspaceFocused = false,
  keybindings,
  matchShortcut
}: {
  activeWorktreeId: string
  floatingWorkspaceFocused?: boolean
  keybindings: KeybindingOverrides
  matchShortcut: (actionId: KeybindingActionId) => boolean
}): TerminalAgentTabShortcut {
  const state = useAppStore.getState()
  if (matchShortcut('tab.newAgent')) {
    const detectedAgentIds = floatingWorkspaceFocused
      ? resolveFloatingDetectedAgentIds(state)
      : (() => {
          const connectionId = getConnectionId(activeWorktreeId)
          return typeof connectionId === 'string'
            ? state.remoteDetectedAgentIds[connectionId]
            : state.detectedAgentIds
        })()
    return {
      actionId: 'tab.newAgent',
      agent: resolveDefaultAgentForNewTab({
        defaultTuiAgent: state.settings?.defaultTuiAgent,
        detectedAgentIds,
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
