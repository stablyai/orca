import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

// Why three sources: Orca-launched tabs, hook-reported agents (SSH too), and a typed `codex` seen locally.
function hasCodexTerminal(state: AppState): boolean {
  return (
    Object.values(state.tabsByWorktree).some((tabs) =>
      tabs.some((tab) => tab.launchAgent === 'codex')
    ) ||
    Object.values(state.agentStatusByPaneKey).some((entry) => entry.agentType === 'codex') ||
    Object.values(state.paneForegroundAgentByPaneKey).some((entry) => entry.agent === 'codex')
  )
}

function didSourcesChange(state: AppState, previous: AppState): boolean {
  return (
    state.tabsByWorktree !== previous.tabsByWorktree ||
    state.agentStatusByPaneKey !== previous.agentStatusByPaneKey ||
    state.paneForegroundAgentByPaneKey !== previous.paneForegroundAgentByPaneKey
  )
}

/** Calls `onAppear` once, as soon as a Codex terminal exists. Returns the unsubscribe. */
export function whenCodexTerminalAppears(onAppear: () => void): () => void {
  if (hasCodexTerminal(useAppStore.getState())) {
    onAppear()
    return () => {}
  }
  // Why a filtered subscription: a selector would rescan every tab on each store write.
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (didSourcesChange(state, previous) && hasCodexTerminal(state)) {
      unsubscribe()
      onAppear()
    }
  })
  return unsubscribe
}
