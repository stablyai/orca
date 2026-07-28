import type { AppState } from '../types'
import { buildTerminalTabRetirementPlans } from './terminal-tab-retirement'
import {
  claimPendingTerminalTabSpawns,
  waitForPendingTerminalTabRetirement
} from './terminal-tab-pending-spawn'

function collectProjectTerminalTabIds(state: AppState, worktreeIds: readonly string[]): string[] {
  const ids = new Set<string>()
  for (const worktreeId of worktreeIds) {
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      ids.add(tab.id)
    }
    for (const tab of state.unifiedTabsByWorktree[worktreeId] ?? []) {
      if (tab.contentType === 'terminal') {
        ids.add(tab.entityId)
      }
    }
  }
  return [...ids]
}

export async function retireRendererProjectTerminalsBeforeRemoval(
  state: AppState,
  worktreeIds: readonly string[],
  options: { providerTeardownTimeoutMs: number; runtimeOwnsProviderTeardown: boolean }
): Promise<Set<string>> {
  const tabIds = collectProjectTerminalTabIds(state, worktreeIds)
  const plans = buildTerminalTabRetirementPlans(state, tabIds)
  const ptyIds = new Set<string>()
  const unprovedPtyIds = new Set<string>()
  for (const plan of plans.values()) {
    for (const ptyId of plan.localOrSshPtyIds) {
      ptyIds.add(ptyId)
    }
    for (const ptyId of plan.unroutablePtyIds) {
      if (ptyId.startsWith('remote:')) {
        if (!options.runtimeOwnsProviderTeardown) {
          unprovedPtyIds.add(ptyId)
        }
      } else {
        // Why: hidden/unhydrated local and SSH worktrees can lack a route, but their exact renderer PTY ids remain kill authority.
        ptyIds.add(ptyId)
      }
    }
    if (!options.runtimeOwnsProviderTeardown) {
      for (const ptyId of plan.runtimeTerminals.map((terminal) => terminal.ptyId)) {
        unprovedPtyIds.add(ptyId)
      }
    }
  }
  if (unprovedPtyIds.size > 0) {
    throw new Error('project_terminal_teardown_unavailable')
  }

  const deadlineMs = Date.now() + options.providerTeardownTimeoutMs
  const retirePty = async (ptyId: string): Promise<void> => {
    await window.api.pty.kill(ptyId, { timeoutMs: Math.max(1, deadlineMs - Date.now()) })
  }
  const retirementTasks = [...ptyIds].map(retirePty)
  for (const tabId of tabIds) {
    for (const pendingSpawn of claimPendingTerminalTabSpawns(tabId)) {
      retirementTasks.push(
        waitForPendingTerminalTabRetirement(
          pendingSpawn.retire(async (ptyId) => {
            // Why: a failed project removal must leave the late PTY addressable for the next attempt.
            state.updateTabPtyId(tabId, ptyId)
            ptyIds.add(ptyId)
            await retirePty(ptyId)
          }),
          deadlineMs - Date.now()
        )
      )
    }
  }
  const results = await Promise.allSettled(retirementTasks)
  if (results.some((result) => result.status === 'rejected')) {
    throw new Error('project_terminal_teardown_failed')
  }
  return new Set(tabIds)
}
