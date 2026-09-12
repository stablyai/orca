import type { AppState } from '@/store/types'
import { collectLeafIdsInOrder } from '../terminal-layout-leaf-ids'

/**
 * Whether a PTY spawned by a pane that was disposed before it bound should be kept alive for the
 * pane's successor instead of killed.
 *
 * A pane can be remounted while its first spawn is still in flight — the direct-SSH reconnect
 * ledger bumps `tab.generation` on any target tab with no PTY, and a tab created seconds after a
 * reconnect has none yet. The remounted pane spawns under the same pane key, and main's pane-spawn
 * reservation hands it the SAME PTY the first spawn is about to receive. Killing that PTY from the
 * disposed transport kills the successor's shell: the tab then closes on the proven exit, or stays
 * bound to a dead PTY when only the synthetic exit arrives. The PTY is only ownerless when the pane
 * surface itself is gone — the tab closed, or the leaf was removed from a split layout — or when the
 * worktree is being deleted: its tabs are still in the store, but the teardown kills from the
 * bound-id ledger, which never learned this id, so a retained PTY there would outlive its worktree.
 */
export function shouldRetainDisposedPaneSpawn(
  state: Pick<AppState, 'tabsByWorktree' | 'terminalLayoutsByTabId' | 'deleteStateByWorktreeId'>,
  worktreeId: string,
  tabId: string,
  leafId: string
): boolean {
  if (state.deleteStateByWorktreeId?.[worktreeId]?.isDeleting) {
    return false
  }
  const tabPresent = Object.values(state.tabsByWorktree).some((tabs) =>
    tabs.some((tab) => tab.id === tabId)
  )
  if (!tabPresent) {
    return false
  }
  // A single-pane tab may have no persisted layout yet; only an explicit layout can say the leaf
  // was removed.
  const root = state.terminalLayoutsByTabId[tabId]?.root
  return !root || collectLeafIdsInOrder(root).includes(leafId)
}
