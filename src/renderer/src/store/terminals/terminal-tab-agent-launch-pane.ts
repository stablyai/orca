import { terminalInputRecordTransition } from './terminal-input-record-transition'
import { getTerminalTabOwnerWorktreeIds } from './terminal-tab-owner-index'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { TerminalSlice, TerminalStoreSet } from './terminal-state'

export function createTerminalTabAgentLaunchPaneActions(
  set: TerminalStoreSet
): Pick<TerminalSlice, 'setTabAgentLaunchPane'> {
  return {
    setTabAgentLaunchPane: (tabId, launchPane, options) => {
      set((s) => {
        const owners = [...getTerminalTabOwnerWorktreeIds(s.tabsByWorktree, tabId)]
        if (owners.length === 0) {
          return s
        }
        const next = { ...s.tabsByWorktree }
        for (const wId of owners) {
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
        return { tabsByWorktree: terminalInputRecordTransition(s.tabsByWorktree, next, owners) }
      })
    }
  }
}
