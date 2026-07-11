import { useAppStore, type AppState } from '@/store'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'

const CLOSE_BATCH_SIZE = 2

type DaemonKillAllResult = {
  killedCount: number
  remainingCount: number
}

export type KillAllTerminalSurfaceState = Pick<
  AppState,
  'activeWorktreeId' | 'ptyIdsByTabId' | 'tabsByWorktree' | 'unifiedTabsByWorktree'
>

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
  closeSurface: (tabId: string, options: { force: true }) => void
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

function getTargetOwners(
  state: KillAllTerminalSurfaceState,
  targetIds: ReadonlySet<string>
): Map<string, string> {
  const ownerByTargetId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      if (targetIds.has(tab.id) && !ownerByTargetId.has(tab.id)) {
        ownerByTargetId.set(tab.id, worktreeId)
      }
    }
  }
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    for (const tab of tabs) {
      if (
        tab.contentType === 'terminal' &&
        targetIds.has(tab.entityId) &&
        !ownerByTargetId.has(tab.entityId)
      ) {
        ownerByTargetId.set(tab.entityId, worktreeId)
      }
    }
  }
  return ownerByTargetId
}

function isTargetPresent(state: KillAllTerminalSurfaceState, targetId: string): boolean {
  return snapshotKillAllTerminalSurfaceIds(state).includes(targetId)
}

function createDefaultDependencies(): KillAllTerminalSurfaceDependencies {
  return {
    getState: useAppStore.getState,
    killDaemonSessions: () => window.api.pty.management.killAll(),
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
  const targetIdSet = new Set(targetIds)

  let daemon: KillAllTerminalSurfacesSummary['daemon']
  try {
    daemon = { status: 'fulfilled', ...(await deps.killDaemonSessions()) }
  } catch {
    daemon = { status: 'rejected' }
  }

  const cleanupState = deps.getState()
  const ownerByTargetId = getTargetOwners(cleanupState, targetIdSet)
  const presentTargetIds = targetIds.filter((targetId) => ownerByTargetId.has(targetId))
  const activeWorktreeId = cleanupState.activeWorktreeId
  // Why: keeping the active worktree until its targets close lets the existing
  // tab action choose editor/browser/deactivation without spawning a replacement.
  const closeOrder = [
    ...presentTargetIds.filter((targetId) => ownerByTargetId.get(targetId) !== activeWorktreeId),
    ...presentTargetIds.filter((targetId) => ownerByTargetId.get(targetId) === activeWorktreeId)
  ]

  const exactPtyIds = new Set<string>()
  for (const targetId of presentTargetIds) {
    for (const ptyId of cleanupState.ptyIdsByTabId[targetId] ?? []) {
      if (ptyId.length > 0 && !ptyId.startsWith('remote:')) {
        exactPtyIds.add(ptyId)
      }
    }
  }

  let failedCloseAttemptCount = 0
  const closeStartedAt = deps.now()
  let closeBatchStartedAt = closeStartedAt
  let maxCloseBatchDurationMs = 0
  let closeYieldCount = 0
  for (let index = 0; index < closeOrder.length; index += 1) {
    const targetId = closeOrder[index]
    let failed = false
    try {
      deps.closeSurface(targetId, { force: true })
    } catch {
      failed = true
    }
    try {
      failed ||= isTargetPresent(deps.getState(), targetId)
    } catch {
      failed = true
    }
    if (failed) {
      failedCloseAttemptCount += 1
    }
    const isBatchEnd = (index + 1) % CLOSE_BATCH_SIZE === 0 || index + 1 === closeOrder.length
    if (isBatchEnd) {
      maxCloseBatchDurationMs = Math.max(maxCloseBatchDurationMs, deps.now() - closeBatchStartedAt)
    }
    if (isBatchEnd && index + 1 < closeOrder.length) {
      // Why: closeTab cascades clone several store maps, so large confirmed
      // snapshots yield between bounded batches instead of monopolizing a frame.
      try {
        await deps.yieldToRenderer()
      } catch {
        // Yield failure is not cleanup failure; keep closing the confirmed set.
      }
      closeYieldCount += 1
      closeBatchStartedAt = deps.now()
    }
  }
  const closeDurationMs = Math.max(0, deps.now() - closeStartedAt)

  const exactKillResults = await Promise.allSettled(
    [...exactPtyIds].map((ptyId) => Promise.resolve().then(() => deps.killPty(ptyId)))
  )
  const exactKillAcceptedCount = exactKillResults.filter(
    (result) => result.status === 'fulfilled'
  ).length
  const finalTargetIds = new Set(snapshotKillAllTerminalSurfaceIds(deps.getState()))
  const absentTargetCount = targetIds.filter((targetId) => !finalTargetIds.has(targetId)).length
  const summary: KillAllTerminalSurfacesSummary = {
    targetCount: targetIds.length,
    closeAttemptCount: closeOrder.length,
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
