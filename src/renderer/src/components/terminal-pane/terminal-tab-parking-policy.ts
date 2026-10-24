import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { ActivityTerminalPortalTarget } from '../activity/activity-terminal-portal'
import { useAppStore } from '../../store'
import { getTerminalTabColdParkRecheckDelayMs } from './terminal-cold-park-recheck-deadlines'
import {
  reconcileTerminalTabColdParkRecheckTimers,
  type TerminalTabColdParkRecheckTimers
} from './terminal-cold-park-recheck-timers'
import {
  TERMINAL_TAB_COLD_PARK_DELAY_MS,
  selectPairedRuntimeParkingEnvironmentIdsFromState,
  selectColdParkedTerminalTabs
} from './terminal-hidden-view-parking'
import {
  selectParkVerdictPinnedTabIds,
  type ParkVerdictFlipRecord
} from './terminal-park-verdict-flip-telemetry'
import { haveSameTerminalTabIds } from './terminal-parking-reconciliation-key'
import { withholdUnparkableTerminalTabs } from './terminal-cold-park-withheld-tabs'
import { getTerminalParkingPolicyOverrides } from './terminal-parking-e2e-overrides'
import { captureNewlyParkedTerminalTabs } from './parked-terminal-tab-capture-episodes'
import type { createTerminalTabActivationOrder } from './terminal-tab-activation-order'
import { buildTerminalTabColdParkCandidates } from './terminal-tab-park-candidates'
export type TerminalOverlayTabAssignment = { groupId: string; isActiveInGroup: boolean }
export type TerminalViewParkingInput = {
  worktreeId: string
  terminalTabs: readonly TerminalTab[]
  assignments: ReadonlyMap<string, TerminalOverlayTabAssignment>
  isWorktreeActive: boolean
  activeTerminalTabId: string | null
  coldParkTerminalPanes: boolean
  isForceParked?: boolean
  shouldMeasureHiddenWorktree: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
  activationDeferredMountTabIds?: ReadonlySet<string> | null
}
export type WorkspacePolicy = {
  input: TerminalViewParkingInput
  hosts: Map<object, { input: TerminalViewParkingInput; parked: ReadonlySet<string> }>
  hiddenSince: Map<string, number>
  activationOrder: ReturnType<typeof createTerminalTabActivationOrder>
  measuring: boolean
  cooldown: number | null
  timers: TerminalTabColdParkRecheckTimers
  flips: Map<string, ParkVerdictFlipRecord>
  captures: Set<string>
  cold: ReadonlySet<string>
  pinned: ReadonlySet<string>
  key: string
  syncKey: string
  snapshot: number
  evaluatedTabs: readonly TerminalTab[]
}
export function evaluateTerminalTabParkingPolicy(
  policy: WorkspacePolicy,
  notify: (id: string) => void,
  queuePolicy: (policy: WorkspacePolicy) => void
): void {
  const { input, hiddenSince, activationOrder, timers, flips, captures } = policy
  const {
    worktreeId,
    terminalTabs,
    assignments,
    isWorktreeActive,
    activeTerminalTabId,
    shouldMeasureHiddenWorktree,
    activityTerminalPortals
  } = input
  const state = useAppStore.getState()
  const nowMs = Date.now()
  const overrides = getTerminalParkingPolicyOverrides()
  const liveTabIds = new Set(terminalTabs.map((tab) => tab.id))
  for (const id of hiddenSince.keys()) {
    if (!liveTabIds.has(id)) {
      hiddenSince.delete(id)
    }
  }
  for (const id of flips.keys()) {
    if (!liveTabIds.has(id)) {
      flips.delete(id)
    }
  }
  activationOrder.retainTabIds(liveTabIds)
  if (!shouldMeasureHiddenWorktree && policy.measuring) {
    policy.cooldown = nowMs + (overrides.coldParkDelayMs ?? TERMINAL_TAB_COLD_PARK_DELAY_MS)
  }
  policy.measuring = shouldMeasureHiddenWorktree
  if (isWorktreeActive) {
    policy.cooldown = null
  }
  const candidates = buildTerminalTabColdParkCandidates({
    terminalTabs,
    assignments,
    isWorktreeActive,
    activeTerminalTabId,
    portalTabIds: new Set(
      activityTerminalPortals.filter((p) => p.worktreeId === worktreeId).map((p) => p.tabId)
    ),
    shouldMeasureHiddenWorktree,
    hiddenSinceByTabId: hiddenSince,
    activationOrder,
    nowMs
  })
  const selected = selectColdParkedTerminalTabs({
    worktreeId,
    terminalTabs: candidates,
    pendingStartupByTabId: state.pendingStartupByTabId,
    parkingEnabled: state.settings?.terminalHiddenViewParking !== false,
    nowMs,
    parkCooldownUntilMs: policy.cooldown,
    restorePolicy: {
      sshParkingEnabled: state.settings?.terminalSshViewParking !== false,
      pairedRuntimeParkingEnvironmentIds: selectPairedRuntimeParkingEnvironmentIdsFromState(state)
    },
    ...overrides
  })
  const { parkedTabIds, parkVerdictPinUntilMsByTabId } = withholdUnparkableTerminalTabs({
    worktreeId,
    terminalTabs,
    coldParkedTabIds: selected,
    parkVerdictRecords: flips,
    nowMs
  })
  captureNewlyParkedTerminalTabs(worktreeId, parkedTabIds, captures)
  const deadlines = new Map<string, number>()
  for (const candidate of candidates) {
    if (
      candidate.isVisible ||
      candidate.hasActivityTerminalPortal ||
      parkedTabIds.has(candidate.id)
    ) {
      continue
    }
    const delay = getTerminalTabColdParkRecheckDelayMs({
      parkingEnabled: state.settings?.terminalHiddenViewParking !== false,
      hiddenSinceMs: candidate.hiddenSinceMs,
      parkCooldownUntilMs: policy.cooldown,
      parkVerdictPinUntilMs: parkVerdictPinUntilMsByTabId.get(candidate.id) ?? null,
      nowMs,
      ...overrides
    })
    if (delay !== null && delay > 0) {
      deadlines.set(candidate.id, nowMs + delay)
    }
  }
  const pin = selectParkVerdictPinnedTabIds({ records: flips, tabIds: liveTabIds, nowMs })
  if (pin.earliestPinExpiryMs !== null) {
    deadlines.set('pin-expiry', pin.earliestPinExpiryMs)
  }
  reconcileTerminalTabColdParkRecheckTimers({
    timers,
    deadlineMsByTabId: deadlines,
    nowMs,
    onDeadline: () => {
      evaluateTerminalTabParkingPolicy(policy, notify, queuePolicy)
      queuePolicy(policy)
    }
  })
  if (
    !haveSameTerminalTabIds(policy.cold, parkedTabIds) ||
    !haveSameTerminalTabIds(policy.pinned, pin.pinnedTabIds)
  ) {
    // Snapshot identity changes only when a view's actual projection can change.
    policy.cold = parkedTabIds
    policy.pinned = pin.pinnedTabIds
    notify(worktreeId)
  }
}
