import type {
  TerminalParkedWatcherBlockedPlan,
  TerminalParkedWatcherCoveragePlan,
  TerminalParkedWatcherCoveredPlan,
  TerminalParkedWatcherPendingPlan
} from './terminal-parked-watcher-coverage-plan'
import type { ParkableTerminalTabModel } from './terminal-parked-watcher-reconciliation'

export type ParkedTerminalTabWatcherSyncArgs = {
  worktreeId: string
  tabs: readonly ParkableTerminalTabModel[]
  parkedTabIds: ReadonlySet<string>
  restoreTitleOnStartTabIds?: ReadonlySet<string>
}

export function terminalParkedWatcherPlanPtyIds(
  plan: TerminalParkedWatcherCoveragePlan | undefined
): string[] {
  return (plan?.panes ?? [])
    .flatMap((pane) => (pane.ptyId === null ? [] : [pane.ptyId]))
    .sort((left, right) => left.localeCompare(right))
}

export type TerminalParkedWatcherSyncFailureReason =
  | 'coverage-plan-missing'
  | 'coverage-plan-not-covered'
  | 'material-changed'
  | 'watcher-start-failed'
  | 'watcher-coverage-incomplete'
  | 'watcher-ownership-lost'

export type TerminalParkedWatcherSyncAcknowledgement =
  | {
      status: 'covering'
      tabId: string
      materialKey: string
      watchedPtyIds: readonly string[]
    }
  | {
      status: 'failed'
      tabId: string
      materialKey: string | null
      reason: TerminalParkedWatcherSyncFailureReason
      expectedPtyIds: readonly string[]
      watchedPtyIds: readonly string[]
    }
  | {
      status: 'forced'
      tabId: string
      materialKey: string | null
      watchedPtyIds: readonly string[]
    }

export type TerminalParkEpisodeLease =
  | { phase: 'pending'; plan: TerminalParkedWatcherPendingPlan }
  | { phase: 'blocked'; plan: TerminalParkedWatcherBlockedPlan }
  | { phase: 'requested'; plan: TerminalParkedWatcherCoveredPlan }
  | { phase: 'covering'; plan: TerminalParkedWatcherCoveredPlan }
  | { phase: 'forced'; plan: TerminalParkedWatcherCoveragePlan }
  | {
      phase: 'rejected'
      plan: TerminalParkedWatcherCoveredPlan
      reason: TerminalParkedWatcherSyncFailureReason
    }

export function reconcileTerminalParkEpisodeLease(
  lease: TerminalParkEpisodeLease | null,
  plan: TerminalParkedWatcherCoveragePlan,
  options?: { forceUnmount?: boolean }
): TerminalParkEpisodeLease {
  if (options?.forceUnmount) {
    return lease?.phase === 'forced' && lease.plan.materialKey === plan.materialKey
      ? lease
      : { phase: 'forced', plan }
  }
  if (lease?.phase !== 'forced' && lease?.plan.materialKey === plan.materialKey) {
    return lease
  }
  if (plan.status === 'pending') {
    return { phase: 'pending', plan }
  }
  if (plan.status === 'blocked') {
    return { phase: 'blocked', plan }
  }
  return { phase: 'requested', plan }
}

export function acknowledgeTerminalParkEpisodeLease(
  lease: TerminalParkEpisodeLease,
  acknowledgement: TerminalParkedWatcherSyncAcknowledgement
): TerminalParkEpisodeLease {
  if (lease.phase === 'forced' || acknowledgement.status === 'forced') {
    return lease
  }
  if (
    acknowledgement.tabId !== lease.plan.tabId ||
    acknowledgement.materialKey !== lease.plan.materialKey ||
    (lease.phase !== 'requested' && lease.phase !== 'covering')
  ) {
    return lease
  }
  if (acknowledgement.status === 'covering') {
    return lease.phase === 'covering' ? lease : { phase: 'covering', plan: lease.plan }
  }
  return { phase: 'rejected', plan: lease.plan, reason: acknowledgement.reason }
}

export function terminalParkEpisodeLeaseUnmountsPane(
  lease: TerminalParkEpisodeLease | null
): boolean {
  return lease?.phase === 'requested' || lease?.phase === 'covering' || lease?.phase === 'forced'
}
