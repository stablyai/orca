import {
  acknowledgeTerminalParkEpisodeLease,
  reconcileTerminalParkEpisodeLease,
  terminalParkEpisodeLeaseUnmountsPane,
  type TerminalParkEpisodeLease,
  type TerminalParkedWatcherSyncAcknowledgement
} from './terminal-park-episode-lease'
import type { TerminalParkedWatcherCoveragePlan } from './terminal-parked-watcher-coverage-plan'
import type { ParkableTerminalTabModel } from './terminal-parked-watcher-reconciliation'

export type TerminalParkEpisodeTab = ParkableTerminalTabModel

export type TerminalParkEpisodeSet = ReadonlyMap<string, TerminalParkEpisodeLease>

export function reconcileTerminalParkEpisodeSet(args: {
  current: TerminalParkEpisodeSet
  tabs: readonly TerminalParkEpisodeTab[]
  requestedTabIds: ReadonlySet<string>
  forcedTabIds?: ReadonlySet<string>
  plan: (tab: TerminalParkEpisodeTab) => TerminalParkedWatcherCoveragePlan
}): {
  leases: TerminalParkEpisodeSet
  plansByTabId: ReadonlyMap<string, TerminalParkedWatcherCoveragePlan>
  unmountTabIds: ReadonlySet<string>
} {
  const leases = new Map<string, TerminalParkEpisodeLease>()
  const plansByTabId = new Map<string, TerminalParkedWatcherCoveragePlan>()
  const unmountTabIds = new Set<string>()

  for (const tab of args.tabs) {
    if (!args.requestedTabIds.has(tab.id)) {
      continue
    }
    const plan = args.plan(tab)
    const lease = reconcileTerminalParkEpisodeLease(args.current.get(tab.id) ?? null, plan, {
      forceUnmount: args.forcedTabIds?.has(tab.id) === true
    })
    leases.set(tab.id, lease)
    plansByTabId.set(tab.id, plan)
    if (terminalParkEpisodeLeaseUnmountsPane(lease)) {
      unmountTabIds.add(tab.id)
    }
  }

  const unchanged =
    leases.size === args.current.size &&
    Array.from(leases).every(([tabId, lease]) => args.current.get(tabId) === lease)
  return {
    leases: unchanged ? args.current : leases,
    plansByTabId,
    unmountTabIds
  }
}

export function selectCurrentTerminalParkEpisodeUnmounts(args: {
  leases: TerminalParkEpisodeSet
  plansByTabId: ReadonlyMap<string, TerminalParkedWatcherCoveragePlan>
  requestedTabIds: ReadonlySet<string>
  forcedTabIds?: ReadonlySet<string>
}): Set<string> {
  const unmountTabIds = new Set<string>()
  for (const tabId of args.requestedTabIds) {
    if (args.forcedTabIds?.has(tabId)) {
      unmountTabIds.add(tabId)
      continue
    }
    const lease = args.leases.get(tabId)
    const plan = args.plansByTabId.get(tabId)
    if (
      lease &&
      plan &&
      lease.plan.materialKey === plan.materialKey &&
      terminalParkEpisodeLeaseUnmountsPane(lease)
    ) {
      unmountTabIds.add(tabId)
    }
  }
  return unmountTabIds
}

export function selectAcknowledgedTerminalParkEpisodeUnmounts(args: {
  leases: TerminalParkEpisodeSet
  plansByTabId: ReadonlyMap<string, TerminalParkedWatcherCoveragePlan>
  requestedTabIds: ReadonlySet<string>
  forcedTabIds?: ReadonlySet<string>
  acknowledgementRequiredTabIds: ReadonlySet<string>
}): Set<string> {
  const unmountTabIds = selectCurrentTerminalParkEpisodeUnmounts(args)
  for (const tabId of args.acknowledgementRequiredTabIds) {
    if (args.leases.get(tabId)?.phase === 'requested') {
      unmountTabIds.delete(tabId)
    }
  }
  return unmountTabIds
}

export function selectTerminalParkEpisodeWatcherTabIds(args: {
  worktreeId: string
  tabIds: readonly string[]
  leases: TerminalParkEpisodeSet
  plansByTabId: ReadonlyMap<string, TerminalParkedWatcherCoveragePlan>
  renderedUnmountTabIds: ReadonlySet<string>
  activationDeferredTabIds?: ReadonlySet<string>
}): Set<string> {
  const watcherTabIds = new Set<string>()
  for (const tabId of args.tabIds) {
    const lease = args.leases.get(tabId)
    const plan = args.plansByTabId.get(tabId)
    if (
      !lease ||
      !plan ||
      plan.worktreeId !== args.worktreeId ||
      lease.plan.materialKey !== plan.materialKey ||
      !terminalParkEpisodeLeaseUnmountsPane(lease)
    ) {
      continue
    }
    const establishedDeferredWatcher =
      args.activationDeferredTabIds?.has(tabId) === true &&
      (lease.phase === 'covering' || lease.phase === 'forced')
    if (args.renderedUnmountTabIds.has(tabId) || establishedDeferredWatcher) {
      watcherTabIds.add(tabId)
    }
  }
  return watcherTabIds
}

export function acknowledgeTerminalParkEpisodeSet(
  current: TerminalParkEpisodeSet,
  acknowledgements: readonly TerminalParkedWatcherSyncAcknowledgement[]
): { leases: TerminalParkEpisodeSet; renderChanged: boolean } {
  let leases: Map<string, TerminalParkEpisodeLease> | null = null
  let renderChanged = false
  for (const acknowledgement of acknowledgements) {
    const currentLease = (leases ?? current).get(acknowledgement.tabId)
    if (!currentLease) {
      continue
    }
    const nextLease = acknowledgeTerminalParkEpisodeLease(currentLease, acknowledgement)
    if (nextLease === currentLease) {
      continue
    }
    leases ??= new Map(current)
    leases.set(acknowledgement.tabId, nextLease)
    renderChanged ||=
      terminalParkEpisodeLeaseUnmountsPane(currentLease) !==
      terminalParkEpisodeLeaseUnmountsPane(nextLease)
  }
  return { leases: leases ?? current, renderChanged }
}
