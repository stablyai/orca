import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'

type NoticeAgent = 'codex' | 'claude'

function paneKeyTabId(paneKey: string): string {
  const separator = paneKey.indexOf(':')
  return separator === -1 ? paneKey : paneKey.slice(0, separator)
}

function isTerminalTab(state: AppState, tabId: string): boolean {
  return Object.values(state.tabsByWorktree).some((tabs) => tabs.some((tab) => tab.id === tabId))
}

// Why three sources: Orca-launched tabs, hook-reported agents (SSH too), and an agent typed in a local pane.
function hasAgentTerminal(state: AppState, agent: NoticeAgent): boolean {
  return (
    Object.values(state.tabsByWorktree).some((tabs) =>
      tabs.some((tab) => tab.launchAgent === agent)
    ) ||
    // Why the terminal-tab check: native chat (agent-session) tabs project status entries too,
    // but they run no CLI in a terminal, so they must not trigger terminal-only notices.
    Object.entries(state.agentStatusByPaneKey).some(
      ([paneKey, entry]) => entry.agentType === agent && isTerminalTab(state, paneKeyTabId(paneKey))
    ) ||
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
