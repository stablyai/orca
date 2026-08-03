import { getConnectionIdFromState } from './connection-owner-resolution'
import type { AppState } from '@/store/types'

type ParkedPaneHostState = Parameters<typeof getConnectionIdFromState>[0] &
  Pick<AppState, 'tabsByWorktree' | 'ptyIdsByTabId'>

// Why: only panes that actually parked on the unresolved-host guard may be
// remounted. Keying off "tab has no PTY" instead would also churn tabs whose
// shell merely exited, remounting them on every repos:changed.
const parkedTabIdsByWorktreeId = new Map<string, Set<string>>()

/** Record that a pane withheld its spawn because its worktree had no known host. */
export function recordTerminalTabParkedOnUnresolvedHost(worktreeId: string, tabId: string): void {
  const parked = parkedTabIdsByWorktreeId.get(worktreeId) ?? new Set<string>()
  parked.add(tabId)
  parkedTabIdsByWorktreeId.set(worktreeId, parked)
}

/** Test seam: drop all parked bookkeeping. */
export function clearTerminalTabsParkedOnUnresolvedHost(): void {
  parkedTabIdsByWorktreeId.clear()
}

/**
 * Parked tabs whose owning host has since hydrated, consumed as they are returned.
 *
 * connectPanePty withholds the spawn while a repo-backed worktree has no known
 * host, so those panes hold an inert transport until something remounts them.
 * Nothing else bumps their generation — an SSH state change only covers tabs on
 * a connected target, so a pane parked before its repo row merged would sit
 * inert until the user reopened it.
 */
export function getTabIdsAwaitingHostHydrationRemount(state: ParkedPaneHostState): string[] {
  const remountable: string[] = []
  for (const [worktreeId, parkedTabIds] of parkedTabIdsByWorktreeId) {
    // Why: undefined means the owner is still unresolved, which is the state the
    // pane already parked on; remounting would just re-park it in a loop.
    if (getConnectionIdFromState(state, worktreeId) === undefined) {
      continue
    }
    const tabs = state.tabsByWorktree?.[worktreeId] ?? []
    for (const tabId of parkedTabIds) {
      const tab = tabs.find((candidate) => candidate.id === tabId)
      const hasLivePty = (state.ptyIdsByTabId?.[tabId]?.length ?? 0) > 0
      // Remount only a tab that still exists and still has no PTY. Either way the
      // entry is consumed below: a closed tab is gone, and one that acquired a PTY
      // by other means is no longer parked.
      if (tab && !tab.ptyId && !hasLivePty) {
        remountable.push(tabId)
      }
    }
    // Why: consume every entry so a remount is attempted once per park. If the
    // retry parks again it re-registers, so this cannot spin on repeated
    // repos:changed events. Cleared after iterating to avoid mutating the live Set.
    parkedTabIdsByWorktreeId.delete(worktreeId)
  }
  return remountable
}
