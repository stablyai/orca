import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TerminalSlice, TerminalStoreSet } from './terminal-state'

export function createTerminalTabAgentLaunchPaneActions(
  set: TerminalStoreSet
): Pick<TerminalSlice, 'setTabAgentLaunchPane'> {
  return {
    setTabAgentLaunchPane: (tabId, launchPane, options) => {
      set((s) => {
        const next = { ...s.tabsByWorktree }
        for (const wId of Object.keys(next)) {
          if (!next[wId].some((t) => t.id === tabId)) {
            continue
          }
          next[wId] = next[wId].map((t): TerminalTab => {
            if (t.id !== tabId) {
              return t
            }
            const { agentLaunchPane: _previous, ...rest } = t
            void _previous
            // The proven remount seam: live PTYs detach and reattach; a refused pane spawns afresh.
            const remounted = options?.remount
              ? { ...rest, generation: (t.generation ?? 0) + 1 }
              : rest
            return launchPane ? { ...remounted, agentLaunchPane: launchPane } : remounted
          })
        }
        return { tabsByWorktree: next }
      })
    }
  }
}
