import { useAppStore, type AppState } from '@/store'
import {
  closeTerminalTab,
  type PrecomputedTerminalCloseState
} from '../terminal/terminal-tab-actions'
import {
  buildTerminalTabRetirementPlans,
  type TerminalTabRetirementPlan,
  type TerminalTabRetirementState
} from '@/store/slices/terminal-tab-retirement'
import { reserveTerminalRetirementTeardowns } from '@/store/slices/terminal-retirement-teardown-reservation'
import { notifyDaemonSessionInventoryInvalidated } from '../status-bar/daemon-session-inventory-invalidation'

const CLOSE_BATCH_SIZE = 2

type DaemonKillAllResult = {
  killedCount: number
  remainingCount: number
  killedSessionIds?: string[]
  listingIncomplete?: boolean
}

export type KillAllTerminalSurfaceState = TerminalTabRetirementState &
  Pick<AppState, 'activeWorktreeId'>

export type KillAllTerminalSurfacesSummary = {
  targetCount: number
  closeAttemptCount: number
  absentTargetCount: number
  failedCloseAttemptCount: number
  exactKillAcceptedCount: number
  exactKillRejectedCount: number
  closeDurationMs: number
  maxCloseBatchDurationMs: number
  closeYieldCount: number
  closePhaseExceededLongTaskBudget: boolean
  daemon:
    | ({ status: 'fulfilled' } & DaemonKillAllResult)
    | {
        status: 'rejected'
      }
}

type KillAllTerminalSurfaceDependencies = {
  getState: () => KillAllTerminalSurfaceState
  killDaemonSessions: () => Promise<DaemonKillAllResult>
  notifyInventoryInvalidated: () => void
  closeSurface: (
    tabId: string,
    options: {
      force: true
      localPtyTeardownOwnedExternally: true
      precomputedRetirementPlan: TerminalTabRetirementPlan
      precomputedCloseState: PrecomputedTerminalCloseState
    }
  ) => void
  killPty: (ptyId: string) => Promise<void>
  now: () => number
  yieldToRenderer: () => Promise<void>
  reportSummary: (summary: KillAllTerminalSurfacesSummary) => void
}

export function snapshotKillAllTerminalSurfaceIds(
  state: KillAllTerminalSurfaceState = useAppStore.getState()
): string[] {
  const targetIds = new Set<string>()
  for (const tabs of Object.values(state.tabsByWorktree)) {
    for (const tab of tabs) {
      targetIds.add(tab.id)
    }
  }
  for (const tabs of Object.values(state.unifiedTabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.contentType === 'terminal') {
        targetIds.add(tab.entityId)
      }
    }
  }
  return [...targetIds]
}

function getTargetIndex(
  state: KillAllTerminalSurfaceState,
  targetIds: ReadonlySet<string>
): {
  ownerByTargetId: Map<string, string>
  terminalIdsByWorktree: Map<string, Set<string>>
} {
  const ownerByTargetId = new Map<string, string>()
  const terminalIdsByWorktree = new Map<string, Set<string>>()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    const ids = terminalIdsByWorktree.get(worktreeId) ?? new Set<string>()
    for (const tab of tabs) {
      ids.add(tab.id)
      if (targetIds.has(tab.id) && !ownerByTargetId.has(tab.id)) {
        ownerByTargetId.set(tab.id, worktreeId)
      }
    }
    terminalIdsByWorktree.set(worktreeId, ids)
  }
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    const ids = terminalIdsByWorktree.get(worktreeId) ?? new Set<string>()
    for (const tab of tabs) {
      if (tab.contentType === 'terminal') {
        ids.add(tab.entityId)
      }
      if (
        tab.contentType === 'terminal' &&
        targetIds.has(tab.entityId) &&
        !ownerByTargetId.has(tab.entityId)
      ) {
        ownerByTargetId.set(tab.entityId, worktreeId)
      }
    }
    terminalIdsByWorktree.set(worktreeId, ids)
  }
  return { ownerByTargetId, terminalIdsByWorktree }
}

function getNextTerminalId(ids: ReadonlySet<string>, closingId: string): string | null {
  for (const id of ids) {
    if (id !== closingId) {
      return id
    }
  }
  return null
}

function createDefaultDependencies(): KillAllTerminalSurfaceDependencies {
  return {
    getState: useAppStore.getState,
    killDaemonSessions: () => window.api.pty.management.killAll(),
    notifyInventoryInvalidated: notifyDaemonSessionInventoryInvalidated,
    closeSurface: closeTerminalTab,
    killPty: (ptyId) => window.api.pty.kill(ptyId),
    now: () => globalThis.performance?.now() ?? Date.now(),
    yieldToRenderer: () =>
      new Promise((resolve) => {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => {
          channel.port1.close()
          channel.port2.close()
          resolve()
        }
        channel.port2.postMessage(undefined)
      }),
    reportSummary: (summary) => console.info('[kill-all-terminal-surfaces]', summary)
  }
}

export async function runKillAllTerminalSurfaces(
  snapshotTargetIds: readonly string[],
  dependencies: Partial<KillAllTerminalSurfaceDependencies> = {}
): Promise<KillAllTerminalSurfacesSummary> {
  const deps = { ...createDefaultDependencies(), ...dependencies }
  const targetIds = [...new Set(snapshotTargetIds)]

  let daemon: KillAllTerminalSurfacesSummary['daemon']
  try {
    daemon = { status: 'fulfilled', ...(await deps.killDaemonSessions()) }
  } catch {
    daemon = { status: 'rejected' }
  }
  try {
    // Management sweeps omit per-PTY exit events; invalidate cached inventories explicitly.
    deps.notifyInventoryInvalidated()
  } catch {
    // A stale badge must not abort the destructive action already in progress.
  }

  const cleanupState = deps.getState()
  const remainingTargetIds = new Set(targetIds)
  const createCloseWave = (state: KillAllTerminalSurfaceState) => {
    const remainingIdSet = new Set(remainingTargetIds)
    const { ownerByTargetId, terminalIdsByWorktree } = getTargetIndex(state, remainingIdSet)
    const presentTargetIds = [...remainingTargetIds].filter((targetId) =>
      ownerByTargetId.has(targetId)
    )
    for (const targetId of remainingTargetIds) {
      if (!ownerByTargetId.has(targetId)) {
        remainingTargetIds.delete(targetId)
      }
    }
    const activeWorktreeId = state.activeWorktreeId
    // Close the active worktree last so existing tab actions can select another surface without spawning one.
    const closeOrder = [
      ...presentTargetIds.filter((targetId) => ownerByTargetId.get(targetId) !== activeWorktreeId),
      ...presentTargetIds.filter((targetId) => ownerByTargetId.get(targetId) === activeWorktreeId)
    ]
    return {
      state,
      ownerByTargetId,
      terminalIdsByWorktree,
      closeOrder,
      retirementPlans: buildTerminalTabRetirementPlans(state, closeOrder)
    }
  }

  let closeWave = createCloseWave(cleanupState)
  const daemonKilledSessionIds = new Set(
    daemon.status === 'fulfilled' ? (daemon.killedSessionIds ?? []) : []
  )
  const scheduledPtyOwners = new Set<string>()
  const exactKillTasks: Promise<void>[] = []
  const attemptedTargetIds: string[] = []
  const failedCloseTargetIds = new Set<string>()
  const closeStartedAt = deps.now()
  let closeBatchStartedAt = closeStartedAt
  let maxCloseBatchDurationMs = 0
  let closeYieldCount = 0
  while (closeWave.closeOrder.length > 0) {
    const batchTargetIds = closeWave.closeOrder.splice(0, CLOSE_BATCH_SIZE)
    let mustReplanAfterYield = false
    for (const targetId of batchTargetIds) {
      remainingTargetIds.delete(targetId)
      attemptedTargetIds.push(targetId)
      const owningWorktreeId = closeWave.ownerByTargetId.get(targetId)!
      const remainingTerminalIds =
        closeWave.terminalIdsByWorktree.get(owningWorktreeId) ?? new Set<string>()
      const nextTerminalTabId = getNextTerminalId(remainingTerminalIds, targetId)
      const { plan: retirementPlan, newlyScheduledPtyOwners } = reserveTerminalRetirementTeardowns(
        closeWave.state,
        closeWave.retirementPlans.get(targetId)!,
        scheduledPtyOwners
      )
      let closeFailed = false
      try {
        deps.closeSurface(targetId, {
          force: true,
          localPtyTeardownOwnedExternally: true,
          precomputedRetirementPlan: retirementPlan,
          precomputedCloseState: {
            owningWorktreeId,
            terminalCountBeforeClose: remainingTerminalIds.size,
            nextTerminalTabId
          }
        })
      } catch {
        closeFailed = true
        failedCloseTargetIds.add(targetId)
      }
      const failedTargetSurvived =
        closeFailed && snapshotKillAllTerminalSurfaceIds(deps.getState()).includes(targetId)
      if (failedTargetSurvived) {
        // A failed pre-mutation tab remains an owner; replan before siblings can lose protected PTYs.
        for (const owner of newlyScheduledPtyOwners) {
          scheduledPtyOwners.delete(owner)
        }
        mustReplanAfterYield = true
        break
      }
      remainingTerminalIds.delete(targetId)
      for (const ptyId of retirementPlan.localOrSshPtyIds) {
        if (daemonKilledSessionIds.has(ptyId)) {
          continue
        }
        try {
          exactKillTasks.push(deps.killPty(ptyId))
        } catch (error) {
          exactKillTasks.push(Promise.reject(error))
        }
      }
    }
    maxCloseBatchDurationMs = Math.max(maxCloseBatchDurationMs, deps.now() - closeBatchStartedAt)
    if (remainingTargetIds.size > 0) {
      // closeTab clones store maps; yield between bounded batches to avoid monopolizing a frame.
      const stateAfterBatch = deps.getState()
      try {
        await deps.yieldToRenderer()
      } catch {
        // Yield failure is not cleanup failure; keep closing the confirmed set.
      }
      closeYieldCount += 1
      closeBatchStartedAt = deps.now()
      const stateAfterYield = deps.getState()
      if (mustReplanAfterYield || stateAfterYield !== stateAfterBatch) {
        // Tabs may move/detach/appear during yields; replan remaining targets to protect survivors.
        closeWave = createCloseWave(stateAfterYield)
      }
    }
  }
  const closeDurationMs = Math.max(0, deps.now() - closeStartedAt)

  // The sweep already settled daemon IDs; await reserved exact kills once per provider identity.
  const exactKillResults = await Promise.allSettled(exactKillTasks)
  const exactKillAcceptedCount = exactKillResults.filter(
    (result) => result.status === 'fulfilled'
  ).length
  const finalTargetIds = new Set(snapshotKillAllTerminalSurfaceIds(deps.getState()))
  const absentTargetCount = targetIds.filter((targetId) => !finalTargetIds.has(targetId)).length
  const failedCloseAttemptCount = attemptedTargetIds.filter(
    (targetId) => failedCloseTargetIds.has(targetId) || finalTargetIds.has(targetId)
  ).length
  const summary: KillAllTerminalSurfacesSummary = {
    targetCount: targetIds.length,
    closeAttemptCount: attemptedTargetIds.length,
    absentTargetCount,
    failedCloseAttemptCount,
    exactKillAcceptedCount,
    exactKillRejectedCount: exactKillResults.length - exactKillAcceptedCount,
    closeDurationMs: Math.round(closeDurationMs * 100) / 100,
    maxCloseBatchDurationMs: Math.round(maxCloseBatchDurationMs * 100) / 100,
    closeYieldCount,
    closePhaseExceededLongTaskBudget: maxCloseBatchDurationMs > 50,
    daemon
  }
  try {
    deps.reportSummary(summary)
  } catch {
    // Diagnostics must not change the already-settled destructive action.
  }
  return summary
}
