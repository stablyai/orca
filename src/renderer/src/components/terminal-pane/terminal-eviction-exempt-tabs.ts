/**
 * Eviction-exempt parked terminal tabs.
 *
 * Why: force-park unmounts restorable tabs under the hidden-worktree retention
 * budget, but some live local PTYs cannot reattach on remount. Those tabs must
 * keep their panes mounted so eviction does not orphan a live shell.
 */
import { useAppStore } from '@/store'
import { isEvictionExemptTerminalPty } from './terminal-hidden-worktree-retention'
import {
  resolveParkedTerminalPaneCandidates,
  type ParkableTerminalTabModel
} from './terminal-parked-tab-watchers'

/**
 * Whether force-park must keep this tab's panes mounted: ANY of its pane PTYs is
 * one a remount could not reattach. Resolved from the same pane candidates as
 * canWatcherCoverParkedTerminalTab — tab.ptyId is only the first leaf's PTY, so
 * a split tab whose SECOND leaf holds the unrestorable PTY fails coverage (and
 * so becomes a retention candidate) yet would otherwise look exempt-free and
 * unmount, orphaning that live shell. tab.ptyId stays in the union in case pane
 * resolution misses it (no layout, no capture).
 *
 * Accepted residual: detection is per pane but retention is per TAB — the whole
 * PaneManager stays mounted, so one exempt leaf also pins its restorable split
 * siblings, and the retention budget cannot bound exempt tabs. Capping them is
 * not an option (eviction orphans the live shell); the real fix is making those
 * pty classes reattachable. Sibling TABS are unaffected — the worktree-level
 * veto was removed (selectRetentionForceParkedTerminalWorktrees never consults
 * tab exemptions).
 */
export function isEvictionExemptTerminalTab(
  tab: ParkableTerminalTabModel,
  worktreeId: string
): boolean {
  if (isEvictionExemptTerminalPty(tab.ptyId, worktreeId)) {
    return true
  }
  return resolveParkedTerminalPaneCandidates(tab, useAppStore.getState()).some((pane) =>
    isEvictionExemptTerminalPty(pane.ptyId, worktreeId)
  )
}

/**
 * Eviction-exempt tab ids for one worktree's tabs, resolved in a single pass.
 *
 * Why: each isEvictionExemptTerminalTab call re-reads the store and can walk the
 * layout tree, so render and watcher-sync consume a memoized set instead of
 * re-asking per tab on every unrelated re-render.
 */
export function selectEvictionExemptTerminalTabIds(
  worktreeId: string,
  tabs: readonly ParkableTerminalTabModel[]
): ReadonlySet<string> {
  const exemptTabIds = new Set<string>()
  for (const tab of tabs) {
    if (isEvictionExemptTerminalTab(tab, worktreeId)) {
      exemptTabIds.add(tab.id)
    }
  }
  return exemptTabIds
}

type EvictionExemptTabLayoutState = {
  terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId?: Record<string, string> } | undefined>
}

/**
 * Memo key over the store half of an exemption verdict: a split add or a
 * re-minted leaf pty changes the layout's pane PTYs without changing the tabs
 * array, and a memo keyed on tabs alone would keep serving an exempt set that
 * misses the new pane — force-park would unmount it and orphan a live shell.
 */
export function selectEvictionExemptTerminalTabLayoutKey(
  state: EvictionExemptTabLayoutState,
  tabs: readonly ParkableTerminalTabModel[]
): string {
  return JSON.stringify(
    tabs.map((tab) => [
      tab.id,
      Object.entries(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}).sort(
        ([leftLeafId], [rightLeafId]) => leftLeafId.localeCompare(rightLeafId)
      )
    ])
  )
}
