import type { TerminalTab } from '../../../shared/terminal-tab-types'
import {
  TERMINAL_WORKTREE_COLD_PARK_DELAY_MS,
  canParkTerminalWorktreeRenderers,
  selectColdParkedTerminalWorktrees,
  type TerminalWorktreeColdParkCandidate
} from './terminal-pane/terminal-hidden-view-parking'
import { getTerminalParkingPolicyOverrides } from './terminal-pane/terminal-parking-e2e-overrides'
import { canWatcherCoverParkedTerminalTab } from './terminal-pane/terminal-parked-tab-watchers'
import type { TerminalParkingFoundation } from './use-terminal-parking-foundation'

export type TerminalParkingPassCandidates = ReturnType<typeof collectTerminalParkingPassCandidates>

export function collectTerminalParkingPassCandidates(controller: TerminalParkingFoundation) {
  const {
    activeView,
    activityTerminalPortals,
    measurableBackgroundWorktreeIdsRef,
    measuringTerminalWorktreeIdsRef,
    mountedWorktreeIdsRef,
    pairedRuntimeParkingEnvironmentIds,
    pendingStartupByTabId,
    renderedActiveWorktreeId,
    tabsByWorktree,
    terminalParkingEnabled,
    terminalSshParkingEnabled,
    terminalWorktreeHiddenSinceRef,
    terminalWorktreeParkCooldownUntilRef,
    terminalWorktreeParkingTimersRef,
    workspaceSurfaceIds,
    workspaceSurfaceIdSet
  } = controller
  const parkingTimers = terminalWorktreeParkingTimersRef.current
  for (const timer of parkingTimers.values()) {
    window.clearTimeout(timer)
  }
  parkingTimers.clear()

  const nowMs = Date.now()
  const overrides = getTerminalParkingPolicyOverrides()
  const portalWorktreeIds = new Set(activityTerminalPortals.map((portal) => portal.worktreeId))
  for (const worktreeId of Array.from(terminalWorktreeHiddenSinceRef.current.keys())) {
    if (!workspaceSurfaceIdSet.has(worktreeId) || !mountedWorktreeIdsRef.current.has(worktreeId)) {
      terminalWorktreeHiddenSinceRef.current.delete(worktreeId)
      measuringTerminalWorktreeIdsRef.current.delete(worktreeId)
      terminalWorktreeParkCooldownUntilRef.current.delete(worktreeId)
    }
  }

  const retentionCandidates: TerminalWorktreeColdParkCandidate[] = []
  for (const worktreeId of workspaceSurfaceIds) {
    if (!mountedWorktreeIdsRef.current.has(worktreeId)) {
      terminalWorktreeHiddenSinceRef.current.delete(worktreeId)
      measuringTerminalWorktreeIdsRef.current.delete(worktreeId)
      terminalWorktreeParkCooldownUntilRef.current.delete(worktreeId)
      continue
    }
    const isVisible = activeView === 'terminal' && renderedActiveWorktreeId === worktreeId
    const shouldMeasureHiddenWorktree =
      !isVisible && measurableBackgroundWorktreeIdsRef.current.has(worktreeId)
    const hasActivityTerminalPortal = portalWorktreeIds.has(worktreeId)
    if (shouldMeasureHiddenWorktree) {
      measuringTerminalWorktreeIdsRef.current.add(worktreeId)
    } else {
      if (measuringTerminalWorktreeIdsRef.current.has(worktreeId)) {
        terminalWorktreeParkCooldownUntilRef.current.set(
          worktreeId,
          nowMs + (overrides.coldParkDelayMs ?? TERMINAL_WORKTREE_COLD_PARK_DELAY_MS)
        )
      }
      measuringTerminalWorktreeIdsRef.current.delete(worktreeId)
    }
    if (isVisible || hasActivityTerminalPortal) {
      terminalWorktreeHiddenSinceRef.current.delete(worktreeId)
      terminalWorktreeParkCooldownUntilRef.current.delete(worktreeId)
    } else if (!shouldMeasureHiddenWorktree) {
      if (!terminalWorktreeHiddenSinceRef.current.has(worktreeId)) {
        terminalWorktreeHiddenSinceRef.current.set(worktreeId, nowMs)
      }
    }

    retentionCandidates.push({
      worktreeId,
      terminalTabs: tabsByWorktree[worktreeId] ?? [],
      isVisible,
      shouldMeasureHiddenWorktree,
      hasActivityTerminalPortal,
      hiddenSinceMs: terminalWorktreeHiddenSinceRef.current.get(worktreeId) ?? null,
      parkCooldownUntilMs: terminalWorktreeParkCooldownUntilRef.current.get(worktreeId) ?? null
    })
  }

  const restorePolicy = {
    sshParkingEnabled: terminalSshParkingEnabled,
    pairedRuntimeParkingEnvironmentIds
  }
  const nextParkedTerminalWorktreeIds = selectColdParkedTerminalWorktrees({
    worktrees: retentionCandidates,
    pendingStartupByTabId,
    parkingEnabled: terminalParkingEnabled,
    nowMs,
    restorePolicy,
    ...overrides
  })
  const watcherCoverageByTabId = new Map<string, boolean>()
  const worktreeTabsAreWatcherCovered = (worktreeId: string, tabs: TerminalTab[]): boolean =>
    tabs.every((tab) => {
      const cached = watcherCoverageByTabId.get(tab.id)
      if (cached !== undefined) {
        return cached
      }
      const covered = canWatcherCoverParkedTerminalTab(worktreeId, tab)
      watcherCoverageByTabId.set(tab.id, covered)
      return covered
    })
  for (const worktreeId of Array.from(nextParkedTerminalWorktreeIds)) {
    if (!worktreeTabsAreWatcherCovered(worktreeId, tabsByWorktree[worktreeId] ?? [])) {
      nextParkedTerminalWorktreeIds.delete(worktreeId)
    }
  }

  return {
    parkingTimers,
    nowMs,
    overrides,
    retentionCandidates,
    restorePolicy,
    nextParkedTerminalWorktreeIds,
    worktreeTabsAreWatcherCovered
  }
}

export function canOrdinarilyParkRetentionCandidate(
  controller: TerminalParkingFoundation,
  pass: TerminalParkingPassCandidates,
  candidate: TerminalWorktreeColdParkCandidate
): boolean {
  const tabs = controller.tabsByWorktree[candidate.worktreeId] ?? []
  const parkEligible = canParkTerminalWorktreeRenderers({
    ...candidate,
    parkCooldownUntilMs: null,
    pendingStartupByTabId: controller.pendingStartupByTabId,
    parkingEnabled: controller.terminalParkingEnabled,
    nowMs: pass.nowMs,
    restorePolicy: pass.restorePolicy,
    ...(pass.overrides.coldParkDelayMs !== undefined
      ? { coldParkDelayMs: pass.overrides.coldParkDelayMs }
      : {})
  })
  return parkEligible && pass.worktreeTabsAreWatcherCovered(candidate.worktreeId, tabs)
}
