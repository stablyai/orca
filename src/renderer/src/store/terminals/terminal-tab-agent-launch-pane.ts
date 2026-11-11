import { replaceTabBuckets } from '@/store/keyed-record-transitions'
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
        const replacements: [string, TerminalTab[]][] = []
        for (const wId of owners) {
          if (!s.tabsByWorktree[wId].some((t) => t.id === tabId)) {
            continue
          }
          const tabs = s.tabsByWorktree[wId].map((t): TerminalTab => {
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
          replacements.push([wId, tabs])
        }
        return { tabsByWorktree: replaceTabBuckets(s.tabsByWorktree, replacements) }
      })
    }
  }
}
