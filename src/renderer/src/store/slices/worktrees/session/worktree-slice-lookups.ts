import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/constants'
import { getTerminalActivationSpawnSuppression } from '../../terminal-activation-spawn-suppression'
import { findKnownWorktreeById } from '../listing/detected-worktree-meta'
import { buildWorktreePurgeState } from '../teardown/worktree-purge-state'
import { locateTerminalTab } from '../../../terminals/terminal-tab-location'
import {
  admitTerminalRecoveryRemount,
  nextTerminalRecoveryLedger,
  settledTerminalRecoveryLedger
} from '../../../terminals/terminal-tab-recovery-ledger'
import type {
  TerminalRecoveryRemountRequest,
  TerminalRecoveryRemountResult
} from '../../../terminals/terminal-tab-recovery-ledger'

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
  return (tabId, request) => {
    const remountRequest: TerminalRecoveryRemountRequest = request ?? {
      // The lifetime bridge's host-hydration remount is an external trigger: it
      // is not a heal attempt, so it neither consumes nor consults the ledger.
      reason: 'reattach-unverifiable',
      trigger: 'external',
      now: Date.now()
    }
    let result: TerminalRecoveryRemountResult = {
      remounted: false,
      declinedBy: 'tab-missing'
    }
    set((s) => {
      const location = locateTerminalTab(s.tabsByWorktree, tabId)
      // Why re-admit inside the write: the caller's read happened before an
      // async liveness probe, and a concurrent detector may have consumed the
      // budget across it. Locating the row and spending its budget is one step.
      const admission = admitTerminalRecoveryRemount(location?.tab, remountRequest)
      if (!location || !admission.admitted) {
        if (admission.admitted) {
          result = { remounted: false, declinedBy: 'tab-missing' }
        } else {
          const { admitted: _admitted, ...decline } = admission
          result = { remounted: false, ...decline }
        }
        return {}
      }
      const { worktreeId, index, tab } = location
      const nextTabs = s.tabsByWorktree[worktreeId].slice()
      const pendingStartup = s.pendingStartupByTabId[tabId]
      // Why: bump generation to remount a pane whose renderer died while its PTY stayed alive, so it reattaches, not spawns.
      const nextTabGeneration = (tab.generation ?? 0) + 1
      // An external remount is not a heal attempt, so it writes no ledger. The
      // generation bump alone supersedes any ledger already on the row, which
      // is exactly right: an external remount IS a new trigger.
      const recovery =
        remountRequest.trigger === 'external'
          ? tab.recovery
          : nextTerminalRecoveryLedger(tab, remountRequest, nextTabGeneration)
      nextTabs[index] = {
        ...tab,
        generation: nextTabGeneration,
        // Why: recovery isn't a user interaction — suppress its PTY updates from reshuffling Recent, like activation remounts.
        pendingActivationSpawn: getTerminalActivationSpawnSuppression(
          s.terminalLayoutsByTabId[tab.id]
        ),
        // The remount and the budget it spends are one write, so no disposal,
        // release path or index drift can undo half of it (crash b5cfc6ca).
        ...(recovery ? { recovery } : {})
      }
      result = { remounted: true, generation: recovery?.generation ?? 0 }
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
    return result
  }
}

export function createSettleTerminalTabRecovery(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['settleTerminalTabRecovery'] {
  return (tabId, generation, outcome) => {
    set((s) => {
      const location = locateTerminalTab(s.tabsByWorktree, tabId)
      if (!location) {
        return {}
      }
      const { worktreeId, index, tab } = location
      const recovery = settledTerminalRecoveryLedger(tab, generation, outcome)
      if (!recovery) {
        return {}
      }
      const nextTabs = s.tabsByWorktree[worktreeId].slice()
      nextTabs[index] = { ...tab, recovery }
      return { tabsByWorktree: { ...s.tabsByWorktree, [worktreeId]: nextTabs } }
    })
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
