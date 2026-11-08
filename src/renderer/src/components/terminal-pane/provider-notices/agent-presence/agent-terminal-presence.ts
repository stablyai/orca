import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'

type NoticeAgent = 'codex' | 'claude'

// Why three sources: Orca-launched tabs, hook-reported agents (SSH too), and an agent typed in a local pane.
function hasAgentTerminal(state: AppState, agent: NoticeAgent): boolean {
  return (
    Object.values(state.tabsByWorktree).some((tabs) =>
      tabs.some((tab) => tab.launchAgent === agent)
    ) ||
    Object.values(state.agentStatusByPaneKey).some((entry) => entry.agentType === agent) ||
    Object.values(state.paneForegroundAgentByPaneKey).some((entry) => entry.agent === agent)
  )
}

function didSourcesChange(state: AppState, previous: AppState): boolean {
  return (
    state.tabsByWorktree !== previous.tabsByWorktree ||
    state.agentStatusByPaneKey !== previous.agentStatusByPaneKey ||
    state.paneForegroundAgentByPaneKey !== previous.paneForegroundAgentByPaneKey
  )
}

/** Calls `onAppear` once, as soon as a terminal running `agent` exists. Returns the unsubscribe. */
export function whenAgentTerminalAppears(agent: NoticeAgent, onAppear: () => void): () => void {
  if (hasAgentTerminal(useAppStore.getState(), agent)) {
    onAppear()
    return () => {}
  }
  // Why a filtered subscription: a selector would rescan every tab on each store write.
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (didSourcesChange(state, previous) && hasAgentTerminal(state, agent)) {
      unsubscribe()
      onAppear()
    }
  })
  return unsubscribe
}
