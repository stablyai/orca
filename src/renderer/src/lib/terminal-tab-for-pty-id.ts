import type { AppState } from '@/store/types'

/** Resolve a synthetic mobile handle's ptyId through persisted tab and split bindings. */
export function resolveTerminalTabIdForPtyId(
  state: Pick<AppState, 'tabsByWorktree' | 'terminalLayoutsByTabId'>,
  worktreeId: string,
  ptyId: string
): string | null {
  const tabs = state.tabsByWorktree[worktreeId] ?? []
  let resolvedTabId: string | null = null
  for (const tab of tabs) {
    const ptyIdsByLeafId = state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId
    const ownsPty =
      tab.ptyId === ptyId ||
      (ptyIdsByLeafId !== undefined && Object.values(ptyIdsByLeafId).includes(ptyId))
    if (!ownsPty) {
      continue
    }
    if (resolvedTabId && resolvedTabId !== tab.id) {
      // Why: stale duplicate ownership must not attach whichever hidden tab
      // happens to appear first in persisted order.
      return null
    }
    resolvedTabId = tab.id
  }
  return resolvedTabId
}
