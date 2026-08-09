/** Commits planned watcher handoffs and reports their exact coverage. */
import { useAppStore } from '@/store'
import { getTerminalProviderSnapshotCapabilityState } from '../terminal/terminal-provider-snapshot-capability'
import { discardPreHandlerPtyState } from './pty-pre-handler-buffer'
import {
  parkedWatcherRestorePolicyFromState,
  reconcileParkedTabWatchers,
  resolveParkedTerminalPaneMaterialBindings,
  startParkedTabWatchers,
  type ParkableTerminalTabModel
} from './terminal-parked-watcher-reconciliation'
import {
  createTerminalParkedWatcherCoveragePlan,
  type ParkedTerminalPtyEligibility,
  type TerminalParkedWatcherCoveragePlan,
  type TerminalParkedWatcherPlanGeneration
} from './terminal-parked-watcher-coverage-plan'
import {
  terminalParkedWatcherPlanPtyIds,
  type ParkedTerminalTabWatcherSyncArgs,
  type TerminalParkedWatcherSyncAcknowledgement,
  type TerminalParkedWatcherSyncFailureReason
} from './terminal-park-episode-lease'
import {
  capturedPanesByTabId,
  disposeParkedTabWatchers,
  parkedWatchersByTabId,
  type ParkedTabWatcherEntry
} from './terminal-parked-watcher-registry'

const materialKeyByWatcherEntry = new WeakMap<ParkedTabWatcherEntry, string>()

export function planParkedTerminalTabWatcherCoverage(
  worktreeId: string,
  tab: ParkableTerminalTabModel,
  options?: {
    generation?: TerminalParkedWatcherPlanGeneration
    isPtyEligible?: ParkedTerminalPtyEligibility
  }
): TerminalParkedWatcherCoveragePlan {
  const state = useAppStore.getState()
  return createTerminalParkedWatcherCoveragePlan({
    worktreeId,
    tab,
    panes: resolveParkedTerminalPaneMaterialBindings(worktreeId, tab, state),
    restorePolicy: parkedWatcherRestorePolicyFromState(state),
    providerSnapshotCapability: getTerminalProviderSnapshotCapabilityState,
    generation: options?.generation ?? tab.generation ?? null,
    ...(options?.isPtyEligible ? { isPtyEligible: options.isPtyEligible } : {})
  })
}

function disposeClosedParkedTabWatchers(
  tabId: string,
  entry: { paneIdByPtyId: ReadonlyMap<string, number> }
): void {
  // Why: a queued pinned-close may close the tab first, leaving no pane to drain retained frames.
  for (const ptyId of entry.paneIdByPtyId.keys()) {
    discardPreHandlerPtyState(ptyId)
  }
  for (const paneId of entry.paneIdByPtyId.values()) {
    useAppStore.getState().clearRuntimePaneTitle(tabId, paneId)
  }
  disposeParkedTabWatchers(tabId)
}

function failedWatcherSync(
  tabId: string,
  plan: TerminalParkedWatcherCoveragePlan | undefined,
  reason: TerminalParkedWatcherSyncFailureReason,
  watchedPtyIds: readonly string[] = []
): TerminalParkedWatcherSyncAcknowledgement {
  disposeParkedTabWatchers(tabId)
  return {
    status: 'failed',
    tabId,
    materialKey: plan?.materialKey ?? null,
    reason,
    expectedPtyIds: terminalParkedWatcherPlanPtyIds(plan),
    watchedPtyIds
  }
}

function startOrReconcileParkedTabWatchers(args: {
  worktreeId: string
  tab: ParkableTerminalTabModel
  restoreTitleOnRegister: boolean
}): void {
  const entry = parkedWatchersByTabId.get(args.tab.id)
  if (entry) {
    reconcileParkedTabWatchers(args.worktreeId, args.tab, entry, args.restoreTitleOnRegister)
  } else {
    startParkedTabWatchers(args.worktreeId, args.tab, args.restoreTitleOnRegister)
  }
}

function restartWatchersForChangedMaterial(tabId: string, materialKey: string): void {
  const entry = parkedWatchersByTabId.get(tabId)
  if (entry && materialKeyByWatcherEntry.get(entry) !== materialKey) {
    disposeParkedTabWatchers(tabId)
  }
}

function syncPlannedParkedTabWatchers(args: {
  worktreeId: string
  tab: ParkableTerminalTabModel
  plan?: TerminalParkedWatcherCoveragePlan
  restoreTitleOnRegister: boolean
}): TerminalParkedWatcherSyncAcknowledgement {
  const { tab, plan } = args
  if (!plan) {
    return failedWatcherSync(tab.id, plan, 'coverage-plan-missing')
  }
  if (plan.status !== 'covered') {
    return failedWatcherSync(tab.id, plan, 'coverage-plan-not-covered')
  }
  const liveTab = (useAppStore.getState().tabsByWorktree[args.worktreeId] ?? []).find(
    (candidate) => candidate.id === tab.id
  )
  if (
    !liveTab ||
    liveTab.ptyId !== plan.tabPtyId ||
    (liveTab.generation ?? null) !== plan.generation ||
    plan.worktreeId !== args.worktreeId
  ) {
    return failedWatcherSync(tab.id, plan, 'material-changed')
  }
  const currentPlan = planParkedTerminalTabWatcherCoverage(args.worktreeId, liveTab)
  if (currentPlan.status !== 'covered' || currentPlan.materialKey !== plan.materialKey) {
    return failedWatcherSync(tab.id, plan, 'material-changed')
  }
  try {
    restartWatchersForChangedMaterial(tab.id, plan.materialKey)
    startOrReconcileParkedTabWatchers({ ...args, tab: liveTab })
  } catch {
    return failedWatcherSync(tab.id, plan, 'watcher-start-failed')
  }
  const entry = parkedWatchersByTabId.get(tab.id)
  const watchedPtyIds = Array.from(entry?.disposersByPtyId.keys() ?? []).sort((left, right) =>
    left.localeCompare(right)
  )
  const expectedPtyIds = terminalParkedWatcherPlanPtyIds(plan)
  if (
    watchedPtyIds.length !== expectedPtyIds.length ||
    expectedPtyIds.some(
      (ptyId, index) => watchedPtyIds[index] !== ptyId || !entry?.paneIdByPtyId.has(ptyId)
    )
  ) {
    return failedWatcherSync(tab.id, plan, 'watcher-coverage-incomplete', watchedPtyIds)
  }
  if (entry) {
    materialKeyByWatcherEntry.set(entry, plan.materialKey)
  }
  return { status: 'covering', tabId: tab.id, materialKey: plan.materialKey, watchedPtyIds }
}

function syncForcedParkedTabWatchers(args: {
  worktreeId: string
  tab: ParkableTerminalTabModel
  plan?: TerminalParkedWatcherCoveragePlan
  restoreTitleOnRegister: boolean
}): TerminalParkedWatcherSyncAcknowledgement {
  try {
    if (args.plan) {
      restartWatchersForChangedMaterial(args.tab.id, args.plan.materialKey)
    }
    startOrReconcileParkedTabWatchers(args)
  } catch {
    return failedWatcherSync(args.tab.id, args.plan, 'watcher-start-failed')
  }
  const entry = parkedWatchersByTabId.get(args.tab.id)
  const watchedPtyIds = Array.from(entry?.disposersByPtyId.keys() ?? []).sort((left, right) =>
    left.localeCompare(right)
  )
  if (entry && args.plan) {
    materialKeyByWatcherEntry.set(entry, args.plan.materialKey)
  }
  return {
    status: 'forced',
    tabId: args.tab.id,
    materialKey: args.plan?.materialKey ?? null,
    watchedPtyIds
  }
}

function syncParkedTerminalTabWatchersInternal(
  args: ParkedTerminalTabWatcherSyncArgs,
  coveragePlansByTabId?: ReadonlyMap<string, TerminalParkedWatcherCoveragePlan>,
  forcedTabIds?: ReadonlySet<string>
): TerminalParkedWatcherSyncAcknowledgement[] {
  const acknowledgements: TerminalParkedWatcherSyncAcknowledgement[] = []
  const liveTabIds = new Set(args.tabs.map((tab) => tab.id))
  for (const [tabId, entry] of parkedWatchersByTabId) {
    if (entry.worktreeId !== args.worktreeId) {
      continue
    }
    if (!liveTabIds.has(tabId)) {
      disposeClosedParkedTabWatchers(tabId, entry)
      continue
    }
    if (!args.parkedTabIds.has(tabId) && entry.disposersByPtyId.size > 0) {
      disposeParkedTabWatchers(tabId)
    }
  }
  // Why: closed tabs never park/reveal again; drop captures to keep the registry bounded.
  for (const [tabId, capture] of capturedPanesByTabId) {
    if (capture.worktreeId === args.worktreeId && !liveTabIds.has(tabId)) {
      capturedPanesByTabId.delete(tabId)
    }
  }
  for (const tab of args.tabs) {
    if (!args.parkedTabIds.has(tab.id)) {
      continue
    }
    const entry = parkedWatchersByTabId.get(tab.id)
    const restoreTitleOnRegister = args.restoreTitleOnStartTabIds?.has(tab.id) === true
    if (coveragePlansByTabId) {
      if (forcedTabIds?.has(tab.id)) {
        acknowledgements.push(
          syncForcedParkedTabWatchers({
            worktreeId: args.worktreeId,
            tab,
            plan: coveragePlansByTabId.get(tab.id),
            restoreTitleOnRegister
          })
        )
        continue
      }
      acknowledgements.push(
        syncPlannedParkedTabWatchers({
          worktreeId: args.worktreeId,
          tab,
          plan: coveragePlansByTabId.get(tab.id),
          restoreTitleOnRegister
        })
      )
      continue
    }
    if (entry) {
      reconcileParkedTabWatchers(args.worktreeId, tab, entry, restoreTitleOnRegister)
    } else {
      startParkedTabWatchers(args.worktreeId, tab, restoreTitleOnRegister)
    }
  }
  return acknowledgements
}

export function syncParkedTerminalTabWatchers(args: ParkedTerminalTabWatcherSyncArgs): void {
  syncParkedTerminalTabWatchersInternal(args)
}

export function syncParkedTerminalTabWatchersWithAcknowledgements(
  args: ParkedTerminalTabWatcherSyncArgs & {
    coveragePlansByTabId: ReadonlyMap<string, TerminalParkedWatcherCoveragePlan>
    forcedTabIds?: ReadonlySet<string>
  }
): TerminalParkedWatcherSyncAcknowledgement[] {
  return syncParkedTerminalTabWatchersInternal(args, args.coveragePlansByTabId, args.forcedTabIds)
}
