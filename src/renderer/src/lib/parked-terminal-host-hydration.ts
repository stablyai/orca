import { getConnectionIdFromState } from './connection-owner-resolution'
import type { AppState } from '@/store/types'

type ParkedPaneHostState = Parameters<typeof getConnectionIdFromState>[0] &
  Pick<AppState, 'tabsByWorktree' | 'ptyIdsByTabId'>

/**
 * Tabs parked with no PTY on a worktree whose owning host has since hydrated.
 *
 * connectPanePty withholds the spawn while a repo-backed worktree has no known
 * host, so those panes hold an inert transport until something remounts them.
 * Nothing else bumps their generation — an SSH state change only covers tabs on
 * a connected target, so a pane parked before its repo row merged would sit
 * inert until the user reopened it.
 */
export function getTabIdsAwaitingHostHydrationRemount(state: ParkedPaneHostState): string[] {
  const remountable: string[] = []
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree ?? {})) {
    if (tabs.length === 0) {
      continue
    }
    // Why: undefined means the owner is still unresolved, which is the state the
    // pane already parked on; only a now-known host warrants a remount.
    if (getConnectionIdFromState(state, worktreeId) === undefined) {
      continue
    }
    for (const tab of tabs) {
      const hasLivePty = (state.ptyIdsByTabId?.[tab.id]?.length ?? 0) > 0
      if (!tab.ptyId && !hasLivePty) {
        remountable.push(tab.id)
      }
    }
  }
  return remountable
}
