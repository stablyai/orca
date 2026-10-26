import type { AgentStatusReadState } from '@/store/agent-status-observers'
import { getAgentStatusState, subscribeAgentStatusState } from '@/store/agent-status'

// Why three sources: Orca-launched tabs, hook-reported agents (SSH too), and a typed `codex` seen locally.
function hasCodexTerminal(state: AgentStatusReadState): boolean {
  return (
    Object.values(state.tabsByWorktree).some((tabs) =>
      tabs.some((tab) => tab.launchAgent === 'codex')
    ) ||
    Object.values(state.agentStatusByPaneKey).some((entry) => entry.agentType === 'codex') ||
    Object.values(state.paneForegroundAgentByPaneKey).some((entry) => entry.agent === 'codex')
  )
}

function didSourcesChange(state: AgentStatusReadState, previous: AgentStatusReadState): boolean {
  return (
    state.tabsByWorktree !== previous.tabsByWorktree ||
    state.agentStatusByPaneKey !== previous.agentStatusByPaneKey ||
    state.paneForegroundAgentByPaneKey !== previous.paneForegroundAgentByPaneKey
  )
}

/** Calls `onAppear` once, as soon as a Codex terminal exists. Returns the unsubscribe. */
export function whenCodexTerminalAppears(onAppear: () => void): () => void {
  if (hasCodexTerminal(getAgentStatusState())) {
    onAppear()
    return () => {}
  }
  // Why a filtered subscription: a selector would rescan every tab on each store write.
  const unsubscribe = subscribeAgentStatusState((state, previous) => {
    if (didSourcesChange(state, previous) && hasCodexTerminal(state)) {
      unsubscribe()
      onAppear()
    }
  })
  return unsubscribe
}
