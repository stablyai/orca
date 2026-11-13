import {
  TERMINAL_WORKTREE_COLD_PARK_DELAY_MS,
  TERMINAL_WORKTREE_HOT_RETAIN_MS,
  TERMINAL_WORKTREE_HOT_RETAIN_LIMIT,
  canParkTerminalWorktreeRenderers,
  selectIdsBeyondHotRetain,
  type TerminalWorktreeColdParkCandidate
} from './terminal-pane/parking/retention/terminal-hidden-view-parking'
import {
  hasPendingRetentionSpawnWork,
  TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS,
  type TerminalWorktreeRetentionCandidate
} from './terminal-pane/parking/retention/terminal-hidden-worktree-retention'
import { getTerminalParkingPolicyOverrides } from './terminal-pane/parking/instrumentation/terminal-parking-e2e-overrides'
import './terminal-pane/parking/output-watchers/terminal-parked-tab-watchers'
import { canWatcherCoverParkedTerminalTab } from './terminal-pane/parking/output-watchers/parked-terminal-tab-coverage'
import { getHeldTerminalPrewarmWorktrees } from './terminal/terminal-worktree-prewarm'
import type { TerminalParkingFoundation } from './use-terminal-parking-foundation'

export type TerminalParkingPassCandidates = ReturnType<typeof collectTerminalParkingPassCandidates>
type CandidateOwner = {
  candidates: Map<string, TerminalWorktreeColdParkCandidate>
  ordinarilyEligible: Map<
    string,
    { id: string; hiddenSinceMs: number; covered: boolean; keepWarm: boolean }
  >
  budget: Map<string, TerminalWorktreeRetentionCandidate>
  phases: Map<string, string>
  ordinaryParked: ReadonlySet<string>
  budgetSnapshot: TerminalWorktreeRetentionCandidate[]
}
const owners = new WeakMap<object, CandidateOwner>()

/** Keep eligibility local; the real cross-workspace budget ranks cached metadata, never rechecks unrelated PTYs. */
export function collectTerminalParkingPassCandidates(
  controller: TerminalParkingFoundation,
  dirty: ReadonlySet<string>
) {
  const {
    activeView,
    activityTerminalPortals,
    measurableBackgroundWorktreeIdsRef,
    measuringTerminalWorktreeIdsRef,
    mountedWorktreeIdsRef,
    pairedRuntimeParkingEnvironmentIds,
    pendingStartupByTabId,
    tabsByWorktree,
    terminalParkingEnabled,
    terminalSshParkingEnabled,
    terminalWorktreeHiddenSinceRef,
    terminalWorktreeParkCooldownUntilRef,
    terminalWorktreeParkingTimersRef,
    visibleWorkspaceIds,
    workspaceSurfaceIdSet
  } = controller
  let owner = owners.get(terminalWorktreeHiddenSinceRef)
  if (!owner) {
    owner = {
      candidates: new Map(),
      ordinarilyEligible: new Map(),
      budget: new Map(),
      phases: new Map(),
      ordinaryParked: new Set(),
      budgetSnapshot: []
    }
    owners.set(terminalWorktreeHiddenSinceRef, owner)
  }
  let rankingChanged = false
  const nowMs = Date.now()
  const overrides = getTerminalParkingPolicyOverrides()
  const restorePolicy = {
    sshParkingEnabled: terminalSshParkingEnabled,
    pairedRuntimeParkingEnvironmentIds
  }
  const parkingTimers = terminalWorktreeParkingTimersRef.current
  const keepWarmWorktreeIds = getHeldTerminalPrewarmWorktrees()
  for (const worktreeId of dirty) {
    const timer = parkingTimers.get(worktreeId)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      parkingTimers.delete(worktreeId)
    }
    if (!workspaceSurfaceIdSet.has(worktreeId) || !mountedWorktreeIdsRef.current.has(worktreeId)) {
      terminalWorktreeHiddenSinceRef.current.delete(worktreeId)
      measuringTerminalWorktreeIdsRef.current.delete(worktreeId)
      terminalWorktreeParkCooldownUntilRef.current.delete(worktreeId)
      rankingChanged ||= owner.candidates.has(worktreeId)
      owner.candidates.delete(worktreeId)
      owner.phases.delete(worktreeId)
      owner.ordinarilyEligible.delete(worktreeId)
      owner.budget.delete(worktreeId)
      continue
    }
    const isVisible = activeView === 'terminal' && visibleWorkspaceIds.includes(worktreeId)
    const shouldMeasureHiddenWorktree =
      !isVisible && measurableBackgroundWorktreeIdsRef.current.has(worktreeId)
    const hasActivityTerminalPortal = activityTerminalPortals.some(
      (portal) => portal.worktreeId === worktreeId
    )
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
    } else if (
      !shouldMeasureHiddenWorktree &&
      !terminalWorktreeHiddenSinceRef.current.has(worktreeId)
    ) {
      terminalWorktreeHiddenSinceRef.current.set(worktreeId, nowMs)
    }
    const terminalTabs = tabsByWorktree[worktreeId] ?? []
    const candidate = {
      worktreeId,
      terminalTabs,
      isVisible,
      shouldMeasureHiddenWorktree,
      hasActivityTerminalPortal,
      hiddenSinceMs: terminalWorktreeHiddenSinceRef.current.get(worktreeId) ?? null,
      parkCooldownUntilMs: terminalWorktreeParkCooldownUntilRef.current.get(worktreeId) ?? null
    }
    owner.candidates.set(worktreeId, candidate)
    const covered = terminalTabs.every((tab) => canWatcherCoverParkedTerminalTab(worktreeId, tab))
    const canPark = (parkCooldownUntilMs: number | null) =>
      canParkTerminalWorktreeRenderers({
        ...candidate,
        parkCooldownUntilMs,
        pendingStartupByTabId,
        parkingEnabled: terminalParkingEnabled,
        nowMs,
        restorePolicy,
        ...(overrides.coldParkDelayMs !== undefined
          ? { coldParkDelayMs: overrides.coldParkDelayMs }
          : {})
      })
    const budgetRow = {
      worktreeId,
      isVisible,
      shouldMeasureHiddenWorktree,
      hasActivityTerminalPortal,
      hiddenSinceMs: candidate.hiddenSinceMs,
      parkCooldownUntilMs: candidate.parkCooldownUntilMs,
      ordinaryParkingCovers: covered && canPark(null),
      hasPendingSpawnWork: terminalTabs.some((tab) =>
        hasPendingRetentionSpawnWork(tab, pendingStartupByTabId)
      )
    }
    const previousBudget = owner.budget.get(worktreeId)
    const phase = [
      candidate.hiddenSinceMs !== null &&
        nowMs >=
          candidate.hiddenSinceMs +
            (overrides.coldParkDelayMs ?? TERMINAL_WORKTREE_COLD_PARK_DELAY_MS),
      candidate.hiddenSinceMs !== null &&
        nowMs >=
          candidate.hiddenSinceMs + (overrides.hotRetainMs ?? TERMINAL_WORKTREE_HOT_RETAIN_MS),
      candidate.hiddenSinceMs !== null &&
        nowMs >=
          candidate.hiddenSinceMs +
            (overrides.retentionTtlMs ?? TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS),
      candidate.parkCooldownUntilMs !== null && nowMs >= candidate.parkCooldownUntilMs
    ].join(',')
    if (
      !previousBudget ||
      previousBudget.hiddenSinceMs !== budgetRow.hiddenSinceMs ||
      previousBudget.isVisible !== budgetRow.isVisible ||
      previousBudget.shouldMeasureHiddenWorktree !== budgetRow.shouldMeasureHiddenWorktree ||
      previousBudget.hasActivityTerminalPortal !== budgetRow.hasActivityTerminalPortal ||
      previousBudget.parkCooldownUntilMs !== budgetRow.parkCooldownUntilMs ||
      previousBudget.ordinaryParkingCovers !== budgetRow.ordinaryParkingCovers ||
      previousBudget.hasPendingSpawnWork !== budgetRow.hasPendingSpawnWork ||
      owner.phases.get(worktreeId) !== phase
    ) {
      rankingChanged = true
    }
    owner.budget.set(worktreeId, budgetRow)
    owner.phases.set(worktreeId, phase)
    if (candidate.hiddenSinceMs !== null && canPark(candidate.parkCooldownUntilMs)) {
      const previousOrdinary = owner.ordinarilyEligible.get(worktreeId)
      const keepWarm = keepWarmWorktreeIds.has(worktreeId)
      if (
        previousOrdinary?.hiddenSinceMs !== candidate.hiddenSinceMs ||
        previousOrdinary.covered !== covered ||
        previousOrdinary.keepWarm !== keepWarm
      ) {
        rankingChanged = true
      }
      owner.ordinarilyEligible.set(worktreeId, {
        id: worktreeId,
        hiddenSinceMs: candidate.hiddenSinceMs,
        covered,
        keepWarm
      })
    } else if (owner.ordinarilyEligible.delete(worktreeId)) {
      rankingChanged = true
    }
  }
  if (rankingChanged) {
    const ranked = selectIdsBeyondHotRetain([...owner.ordinarilyEligible.values()], {
      nowMs,
      hotRetainMs: overrides.hotRetainMs ?? TERMINAL_WORKTREE_HOT_RETAIN_MS,
      hotRetainLimit: overrides.hotRetainLimit ?? TERMINAL_WORKTREE_HOT_RETAIN_LIMIT
    })
    for (const id of ranked) {
      const row = owner.ordinarilyEligible.get(id)
      if (!row?.covered || row.keepWarm) {
        ranked.delete(id)
      }
    }
    owner.ordinaryParked = ranked
    owner.budgetSnapshot = [...owner.budget.values()]
  }
  return {
    parkingTimers,
    nowMs,
    overrides,
    restorePolicy,
    rankingChanged,
    nextParkedTerminalWorktreeIds: new Set(owner.ordinaryParked),
    candidateForWorktree: (id: string) => owner.candidates.get(id),
    retentionBudgetCandidates: owner.budgetSnapshot
  }
}
