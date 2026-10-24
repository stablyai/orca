import type { AgentStatusReadState } from '@/store/agent-status-observers'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { worktreeUsesRemoteConnection } from '@/store/terminals/terminal-workspace-routing'
import { hasRemoteRuntimePtyForTab } from './tab-agent-remote-pty-selector'
import {
  resolveFocusedTabAgent,
  resolveSiblingTabAgent,
  resolveFocusedCompletedTabAgent,
  resolveFocusedRetainedTabAgent
} from './tab-agent'

export function tabAgentExitSignals(state: AgentStatusReadState, tab: TerminalTab) {
  const layout = state.terminalLayoutsByTabId[tab.id]
  const activeLeafId = layout?.activeLeafId
  const ptyIds = state.ptyIdsByTabId[tab.id] ?? []
  const ptyId =
    (activeLeafId ? layout?.ptyIdsByLeafId?.[activeLeafId] : null) ||
    (ptyIds.length === 1 ? ptyIds[0] : null)
  const paneKey =
    activeLeafId && isTerminalLeafId(activeLeafId) ? makePaneKey(tab.id, activeLeafId) : null
  const process = paneKey ? state.paneForegroundAgentByPaneKey[paneKey] : undefined
  const hookAgent = resolveFocusedTabAgent(state.agentStatusByPaneKey, layout, tab.id)
  const siblingHookAgent = resolveSiblingTabAgent(state.agentStatusByPaneKey, layout, tab.id)
  const completed =
    resolveFocusedCompletedTabAgent(state.agentStatusByPaneKey, layout, tab.id) ??
    resolveFocusedRetainedTabAgent(state.retainedAgentsByPaneKey, layout, tab.id)
  const hasCompletedHook =
    completed !== null &&
    (Boolean(activeLeafId && isTerminalLeafId(activeLeafId)) || ptyIds.length <= 1)
  const isRemote =
    worktreeUsesRemoteConnection(state, tab.worktreeId) ||
    hasRemoteRuntimePtyForTab(ptyIds, layout?.ptyIdsByLeafId)
  return {
    generation: `${ptyId ?? ''}|${String(isRemote)}`,
    hookAgent,
    siblingHookAgent,
    hasCompletedHook,
    isRemote,
    processAgent: process?.agent,
    processShellForeground: process?.shellForeground
  }
}
