import { getConnectionIdFromState } from './connection-owner-resolution'
import type { AppState } from '@/store/types'

type ParkedPaneHostState = Parameters<typeof getConnectionIdFromState>[0] &
  Pick<AppState, 'tabsByWorktree' | 'ptyIdsByTabId'>

// Track actual unresolved-host parks; treating every PTY-less tab as parked would repeatedly remount exited shells.
const parkedTabIdsByWorktreeId = new Map<string, Set<string>>()

export function recordTerminalTabParkedOnUnresolvedHost(worktreeId: string, tabId: string): void {
  const parked = parkedTabIdsByWorktreeId.get(worktreeId) ?? new Set<string>()
  parked.add(tabId)
  parkedTabIdsByWorktreeId.set(worktreeId, parked)
}

export function clearTerminalTabsParkedOnUnresolvedHost(): void {
  parkedTabIdsByWorktreeId.clear()
}

/** Consume parks once their owner hydrates. Spawns withheld before repo merge otherwise keep inert transport: SSH changes do not recover a tab parked before target ownership existed. */
export function getTabIdsAwaitingHostHydrationRemount(state: ParkedPaneHostState): string[] {
  const remountable: string[] = []
  for (const [worktreeId, parkedTabIds] of parkedTabIdsByWorktreeId) {
    // Unresolved owners would immediately re-park; wait for hydration instead of remount loops.
    if (getConnectionIdFromState(state, worktreeId) === undefined) {
      continue
    }
    const tabs = state.tabsByWorktree?.[worktreeId] ?? []
    for (const tabId of parkedTabIds) {
      const tab = tabs.find((candidate) => candidate.id === tabId)
      const hasLivePty = (state.ptyIdsByTabId?.[tabId]?.length ?? 0) > 0
      // Consume closed/already-spawned entries too; only existing PTY-less tabs still need remount.
      if (tab && !tab.ptyId && !hasLivePty) {
        remountable.push(tabId)
      }
    }
    // Consume once per park; retries re-register if needed. Clear after iteration to avoid mutating the live Set.
    parkedTabIdsByWorktreeId.delete(worktreeId)
  }
  return remountable
}
