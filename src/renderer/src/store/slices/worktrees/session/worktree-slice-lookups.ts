import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import { getTerminalActivationSpawnSuppression } from '../../terminal-activation-spawn-suppression'
import { findKnownWorktreeById } from '../listing/detected-worktree-meta'
import { buildWorktreePurgeState } from '../teardown/worktree-purge-state'
import { locateTerminalTab } from '../../../terminals/terminal-tab-location'

export function createSetRenamingWorktreeId(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['setRenamingWorktreeId'] {
  return (request) => {
    set({
      renamingWorktreeId: typeof request === 'string' ? { worktreeId: request } : request
    })
  }
}

export function createRemountTerminalTabForRecovery(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['remountTerminalTabForRecovery'] {
  return (tabId) => {
    let remounted = false
    set((s) => {
      const location = locateTerminalTab(s.tabsByWorktree, tabId)
      if (!location) {
        return {}
      }
      const { worktreeId, index, tab } = location
      const nextTabs = s.tabsByWorktree[worktreeId].slice()
      const pendingStartup = s.pendingStartupByTabId[tabId]
      nextTabs[index] = {
        ...tab,
        // Why: bump generation to remount a pane whose renderer died while its PTY stayed alive, so it reattaches, not spawns.
        generation: (tab.generation ?? 0) + 1,
        // Why: recovery isn't a user interaction — suppress its PTY updates from reshuffling Recent, like activation remounts.
        pendingActivationSpawn: getTerminalActivationSpawnSuppression(
          s.terminalLayoutsByTabId[tab.id]
        )
      }
      remounted = true
      return {
        tabsByWorktree: {
          ...s.tabsByWorktree,
          [worktreeId]: nextTabs
        },
        ...(pendingStartup
          ? {
              // Why: a remounted pane must own a distinct one-shot startup record so a stale
              // pane cannot consume the successor's command during teardown.
              pendingStartupByTabId: {
                ...s.pendingStartupByTabId,
                [tabId]: { ...pendingStartup }
              }
            }
          : {})
      }
    })
    return remounted
  }
}

export function createAllWorktrees(
  _set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['allWorktrees'] {
  return () => Object.values(get().worktreesByRepo).flat()
}

export function createGetKnownWorktreeById(
  _set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['getKnownWorktreeById'] {
  return (worktreeId, executionHostId) => findKnownWorktreeById(get(), worktreeId, executionHostId)
}

export function createPurgeWorktreeTerminalState(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['purgeWorktreeTerminalState'] {
  return (worktreeTargets) => {
    const purgeableWorktreeTargets = worktreeTargets.filter((target) => {
      const worktreeId = typeof target === 'string' ? target : target.id
      return worktreeId !== FLOATING_TERMINAL_WORKTREE_ID
    })
    if (purgeableWorktreeTargets.length === 0) {
      return
    }
    set((s) => buildWorktreePurgeState(s, purgeableWorktreeTargets))
  }
}
