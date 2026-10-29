import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TerminalSlice, TerminalStoreSet } from './terminal-state'
import { editSessionSource } from '../session-source-edits'

export function createTerminalTabAgentLaunchPaneActions(
  set: TerminalStoreSet
): Pick<TerminalSlice, 'setTabAgentLaunchPane'> {
  return {
    setTabAgentLaunchPane: (tabId, launchPane, options) => {
      set((s) => {
        const edit = editSessionSource(s)
        for (const [wId, tabs] of Object.entries(s.tabsByWorktree)) {
          if (!tabs.some((t) => t.id === tabId)) {
            continue
          }
          edit.set(
            'tabsByWorktree',
            wId,
            tabs.map((t): TerminalTab => {
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
          )
        }
        return edit.finish()
      })
    }
  }
}
