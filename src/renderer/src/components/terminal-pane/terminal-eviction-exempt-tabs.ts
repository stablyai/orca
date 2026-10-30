/** Keep unrestorable live PTYs mounted through force-park so remount cannot orphan their shells. */
import { useAppStore } from '@/store'
import { isEvictionExemptTerminalPty } from './terminal-hidden-worktree-retention'
import {
  resolveParkedTerminalPaneCandidates,
  type ParkableTerminalTabModel
} from './terminal-parked-tab-watchers'

/** Check every split PTY plus tab.ptyId fallback; the first leaf alone misses unrestorable siblings. Retention is per tab, so one exempt pane pins its split siblings beyond the budget; sibling tabs remain evictable. */
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

/** Memoize once per worktree; individual checks reread store and may walk layout trees. */
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

/** Include layout PTYs in memo identity: splits and rebound leaves can change without reminting tabs. */
export function selectEvictionExemptTerminalTabLayoutKey(
  state: EvictionExemptTabLayoutState,
  tabs: readonly ParkableTerminalTabModel[]
): string {
  return tabs
    .map((tab) => {
      const ptyIdsByLeafId = state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
      const leafPtys = Object.entries(ptyIdsByLeafId)
        .map(([leafId, ptyId]) => `${leafId}:${ptyId}`)
        .join(',')
      return `${tab.id}=${leafPtys}`
    })
    .join('|')
}
