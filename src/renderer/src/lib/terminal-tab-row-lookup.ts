import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

/**
 * Locate a tab row and the worktree key it is filed under, across every key.
 *
 * Why across every key: ownership is tab-keyed, so a row can sit under a workspace key other
 * than the one a caller started from, and looking only there reports it missing.
 */
export function findTerminalTabRow(
  state: Pick<AppState, 'tabsByWorktree'>,
  tabId: string
): { tab: TerminalTab; worktreeId: string } | null {
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === tabId)
    if (tab) {
      return { tab, worktreeId }
    }
  }
  return null
}
