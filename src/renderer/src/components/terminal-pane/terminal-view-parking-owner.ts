import { clearTerminalTabColdParkRecheckTimers } from './terminal-cold-park-recheck-timers'
import {
  recordParkVerdictFlips,
  selectParkVerdictPinnedTabIds
} from './terminal-park-verdict-flip-telemetry'
import { projectTerminalParkingVerdict } from './terminal-view-parking-verdict'
import {
  syncParkedTerminalTabWatchersForWorkspaces,
  disposeAllParkedTerminalWatchers,
  type ParkedTerminalTabWatcherSyncEntry
} from './terminal-parked-tab-watchers'
import { createTerminalTabActivationOrder } from './terminal-tab-activation-order'
import {
  haveSameTerminalTabIds,
  getTerminalParkingAssignmentsKey,
  getTerminalParkingInputsKey,
  getWatcherReconciliationKey
} from './terminal-parking-reconciliation-key'
import {
  evaluateTerminalTabParkingPolicy,
  type WorkspacePolicy,
  type TerminalViewParkingInput
} from './terminal-tab-parking-policy'
import { subscribeTerminalParkingInputs } from './terminal-parking-root-inputs'
export type { TerminalViewParkingInput } from './terminal-tab-parking-policy'
type TerminalViewParkingHost = Readonly<Record<string, never>>
const EMPTY: ReadonlySet<string> = new Set()
const policies = new Map<string, WorkspacePolicy>()
const listeners = new Map<string, Set<() => void>>()
const flushListeners = new Set<() => void>()
const pending = new Map<string, ParkedTerminalTabWatcherSyncEntry>()
const fallback = new Map<string, ParkedTerminalTabWatcherSyncEntry>()
let revision = 0
export const subscribeTerminalParkingFlush = (listener: () => void): (() => void) => {
  flushListeners.add(listener)
  return () => {
    flushListeners.delete(listener)
  }
}
export const getTerminalParkingRevision = (): number => revision
function requestFlush(): void {
  revision += 1
  for (const listener of flushListeners) {
    listener()
  }
}
export function subscribeTerminalViewParking(worktreeId: string, listener: () => void): () => void {
  let bucket = listeners.get(worktreeId)
  if (!bucket) {
    listeners.set(worktreeId, (bucket = new Set()))
  }
  bucket.add(listener)
  return () => {
    bucket.delete(listener)
    if (bucket.size === 0) {
      listeners.delete(worktreeId)
    }
  }
}
export function getTerminalViewParkingSnapshot(worktreeId: string): number {
  return policies.get(worktreeId)?.snapshot ?? 0
}

export function projectTerminalViewParking(args: TerminalViewParkingInput): ReadonlySet<string> {
  const policy = policies.get(args.worktreeId)
  return projectTerminalParkingVerdict(args, policy?.cold ?? EMPTY, policy?.pinned ?? EMPTY)
}
function notify(worktreeId: string): void {
  const policy = policies.get(worktreeId)
  if (policy) {
    policy.snapshot += 1
  }
  for (const listener of listeners.get(worktreeId) ?? []) {
    listener()
  }
}
function evaluate(policy: WorkspacePolicy): void {
  evaluateTerminalTabParkingPolicy(policy, notify, queuePolicy)
}
function queuePolicy(policy: WorkspacePolicy): void {
  const { worktreeId, terminalTabs, activationDeferredMountTabIds } = policy.input
  const parked = policy.hosts.size
    ? new Set(
        terminalTabs
          .filter((tab) => [...policy.hosts.values()].every((host) => host.parked.has(tab.id)))
          .map((tab) => tab.id)
      )
    : projectTerminalParkingVerdict(policy.input, policy.cold, policy.pinned)
  const key = JSON.stringify([
    getTerminalParkingInputsKey(terminalTabs),
    getTerminalParkingAssignmentsKey(policy.input.assignments),
    [...parked],
    [...(activationDeferredMountTabIds ?? [])],
    parked.size ? getWatcherReconciliationKey(terminalTabs) : ''
  ])
  if (key === policy.syncKey) {
    return
  }
  policy.syncKey = key
  pending.set(worktreeId, {
    tabs: terminalTabs,
    parkedTabIds: parked,
    restoreTitleOnStartTabIds: activationDeferredMountTabIds ?? undefined
  })
  requestFlush()
}
export function commitTerminalViewParking(
  host: TerminalViewParkingHost,
  input: TerminalViewParkingInput,
  parked: ReadonlySet<string>
): void {
  if (input.terminalTabs.length === 0) {
    return
  }
  let policy = policies.get(input.worktreeId)
  if (!policy) {
    policy = {
      input,
      hosts: new Map(),
      hiddenSince: new Map(),
      activationOrder: createTerminalTabActivationOrder(),
      measuring: false,
      cooldown: null,
      timers: new Map(),
      flips: new Map(),
      captures: new Set(),
      cold: EMPTY,
      pinned: EMPTY,
      key: '',
      syncKey: '',
      evaluatedTabs: [],
      snapshot: 0
    }
    policies.set(input.worktreeId, policy)
  }
  policy.hosts.set(host, { input, parked })
  const hosts = [...policy.hosts.values()]
  const active = hosts.find((h) => h.input.isWorktreeActive)?.input
  policy.input = {
    ...(active ?? input),
    isWorktreeActive: Boolean(active),
    shouldMeasureHiddenWorktree: hosts.some((h) => h.input.shouldMeasureHiddenWorktree)
  }
  const key = JSON.stringify([
    getTerminalParkingInputsKey(input.terminalTabs),
    getTerminalParkingAssignmentsKey(policy.input.assignments),
    policy.input.isWorktreeActive,
    policy.input.activeTerminalTabId,
    policy.input.shouldMeasureHiddenWorktree,
    policy.input.coldParkTerminalPanes,
    policy.input.isForceParked,
    [...(input.activationDeferredMountTabIds ?? [])],
    input.activityTerminalPortals.map((p) => [p.worktreeId, p.tabId])
  ])
  if (
    policy.key !== key ||
    (!input.coldParkTerminalPanes && policy.evaluatedTabs !== input.terminalTabs)
  ) {
    policy.evaluatedTabs = input.terminalTabs
    policy.key = key
    evaluate(policy)
  }
  recordParkVerdictFlips({
    records: policy.flips,
    liveTabIds: new Set(input.terminalTabs.map((t) => t.id)),
    nextParkedTabIds:
      policy.hosts.size === 1
        ? parked
        : new Set(
            input.terminalTabs
              .filter((t) => [...policy.hosts.values()].every((h) => h.parked.has(t.id)))
              .map((t) => t.id)
          ),
    nowMs: Date.now(),
    allowSustainedPin: !policy.input.isForceParked
  })
  const pin = selectParkVerdictPinnedTabIds({
    records: policy.flips,
    tabIds: input.terminalTabs.map((t) => t.id),
    nowMs: Date.now()
  })
  if (!haveSameTerminalTabIds(policy.pinned, pin.pinnedTabIds)) {
    policy.pinned = pin.pinnedTabIds
    notify(input.worktreeId)
    evaluate(policy)
  }
  queuePolicy(policy)
}
export function detachTerminalViewParking(host: TerminalViewParkingHost, worktreeId: string): void {
  const policy = policies.get(worktreeId)
  if (!policy) {
    return
  }
  policy.hosts.delete(host)
  const active = [...policy.hosts.values()].find((h) => h.input.isWorktreeActive)?.input
  policy.input = { ...(active ?? policy.input), isWorktreeActive: Boolean(active) }
  // Presentation departure withdraws visibility, never runtime ownership or its clocks.
  policy.key = ''
  evaluate(policy)
  queuePolicy(policy)
}
export function commitTerminalWatcherFallback(
  entries: ReadonlyMap<string, ParkedTerminalTabWatcherSyncEntry>,
  capabilityRevision = 0
): void {
  if (capabilityRevision !== snapshotCapabilityRevision) {
    snapshotCapabilityRevision = capabilityRevision
    for (const policy of policies.values()) {
      evaluate(policy)
      notify(policy.input.worktreeId)
      queuePolicy(policy)
    }
  }
  for (const [id, entry] of entries) {
    if (entry.tabs.length) {
      fallback.set(id, entry)
    } else {
      fallback.delete(id)
    }
    if (!policies.has(id)) {
      pending.set(id, entry)
    }
  }
  if (pending.size) {
    requestFlush()
  }
}
let snapshotCapabilityRevision = 0
export function flushTerminalViewParking(): void {
  const batch = new Map(pending)
  pending.clear()
  for (const [id, entry] of batch) {
    const policy = policies.get(id)
    if (!policy) {
      continue
    }
    const key = JSON.stringify([
      getTerminalParkingInputsKey(policy.input.terminalTabs),
      getTerminalParkingAssignmentsKey(policy.input.assignments),
      [...entry.parkedTabIds],
      [...(entry.restoreTitleOnStartTabIds ?? [])],
      entry.parkedTabIds.size ? getWatcherReconciliationKey(policy.input.terminalTabs) : ''
    ])
    policy.syncKey = key
  }
  syncParkedTerminalTabWatchersForWorkspaces(batch)
}
export function startTerminalViewParkingOwner(): () => void {
  const unsubscribe = subscribeTerminalParkingInputs({
    policies,
    pending,
    fallback,
    evaluate,
    queuePolicy,
    notify,
    requestFlush
  })
  return () => {
    unsubscribe()
    disposeTerminalViewParkingOwner()
  }
}
export function disposeTerminalViewParkingOwner(): void {
  for (const policy of policies.values()) {
    clearTerminalTabColdParkRecheckTimers(policy.timers)
  }
  policies.clear()
  pending.clear()
  fallback.clear()
  disposeAllParkedTerminalWatchers()
}
