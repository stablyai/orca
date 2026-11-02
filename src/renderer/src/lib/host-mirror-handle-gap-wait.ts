import { useAppStore } from '@/store'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { WEB_SESSION_TAB_RPC_TIMEOUT_MS } from '@/runtime/web-session-tab-rpc-timeout'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  isDisconnectedRuntimeHostState,
  runtimeHostConnectionStateForEntry
} from '@/runtime/runtime-host-connection-state'

/** Published rows can precede PTY handles; missing handles remain unverifiable, never exited (#19735, ssh-execution-boundary.md). Replay on handle/retraction/deadline without authorizing local replacement. Reconnects/outages invalidate the budget; sustained churn may legitimately keep recovery parked. */
export const HOST_MIRROR_HANDLE_GAP_DEADLINE_MS = WEB_SESSION_TAB_RPC_TIMEOUT_MS

type HandleGapWaiter = {
  worktreeId: string
  tabId: string
  /** Connection generation the wait was armed on; its verdict is void on any other. */
  generation: number
  /** Contact epoch detects same-runtime outages that leave connection generation unchanged (#19647). */
  contactEpoch: number
  /** Which PANE this wait is about, captured at park time; see ExpiredHandleGapVerdict. */
  paneBinding: string
  deadline: ReturnType<typeof setTimeout>
  run: () => void
}

type HandleGapStoreState = Pick<
  ReturnType<typeof useAppStore.getState>,
  'ptyIdsByTabId' | 'tabsByWorktree'
>

const waitersByPane = new Map<string, HandleGapWaiter>()
/** Expire verdicts by global stale generation, same-environment row death, teardown or published handle. Read-time park binding rejects reused panes while preserving genuine reattach. Retraction without later recording may retain an inert entry/subscription until the 512 cap; do not evict on transient binding loss. */
type ExpiredHandleGapVerdict = {
  generation: number
  /** Sorted environment-minted PTY ids the tab's leaves held AT PARK TIME; '' when none. */
  paneBinding: string
}
const MAX_EXPIRED_HANDLE_GAP_VERDICTS = 512
const expiredGenerationByPane = new Map<string, ExpiredHandleGapVerdict>()
let unsubscribeStore: (() => void) | null = null

function paneWaitKey(environmentId: string, tabId: string): string {
  return `${environmentId}\0${tabId}`
}

/** Use layout bindings for pane identity: published handles are empty during the gap, while layout still proves environment ownership. */
function paneBindingFor(tabId: string, environmentId: string): string {
  const bindings = useAppStore.getState().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
  return Object.values(bindings)
    .filter(
      (ptyId): ptyId is string =>
        typeof ptyId === 'string' && parseRemoteRuntimePtyId(ptyId)?.environmentId === environmentId
    )
    .sort()
    .join('')
}

export function hasHostMirrorHandleWaitExpired(environmentId: string, tabId: string): boolean {
  const verdict = expiredGenerationByPane.get(paneWaitKey(environmentId, tabId))
  if (verdict === undefined || verdict.paneBinding === '') {
    // Empty bindings must never match different panes; production parking excludes them, but defensive refusal safely costs another wait if predicates drift.
    return false
  }
  return (
    verdict.generation === getRuntimeEnvironmentConnectionGeneration(environmentId) &&
    // Why this and not the key alone: the key is a tab id, and the pane behind it can be replaced.
    verdict.paneBinding === paneBindingFor(tabId, environmentId)
  )
}

function liveTabIds(): Set<string> {
  const tabIds = new Set<string>()
  for (const tabs of Object.values(useAppStore.getState().tabsByWorktree)) {
    for (const tab of tabs) {
      tabIds.add(tab.id)
    }
  }
  return tabIds
}

/** Only explicit disconnected/reconnecting states prove an outage; never-probed hosts do not. Generation alone misses disconnects until a new runtime reconnects. */
function environmentContactIsLost(environmentId: string): boolean {
  const connectionState = runtimeHostConnectionStateForEntry(
    useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)
  )
  return isDisconnectedRuntimeHostState(connectionState) || connectionState === 'reconnecting'
}

/** Detect contact recovery inside a budget even if the host is reachable again by its deadline. */
function hostContactEpochFor(environmentId: string): number {
  return (
    useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)?.hostContactEpoch ?? 0
  )
}

function recordExpiredWait(environmentId: string, key: string): void {
  const generation = getRuntimeEnvironmentConnectionGeneration(environmentId)
  // Generation expiry is global; transient row absence must remain scoped to the recording environment.
  const prefix = `${environmentId}\0`
  const liveTabs = liveTabIds()
  for (const [staleKey, stale] of expiredGenerationByPane) {
    // Prune obsolete generations across every environment, including reconnected hosts that never record again.
    const staleEnvironmentId = staleKey.slice(0, staleKey.indexOf('\0'))
    if (stale.generation !== getRuntimeEnvironmentConnectionGeneration(staleEnvironmentId)) {
      expiredGenerationByPane.delete(staleKey)
      continue
    }
    // TAB DEATH, this environment ONLY. Unlike a generation, row absence is transient: a sibling
    // mid-republish has no rows for a frame and would lose a verdict its pane still needs. What
    // licenses the inference here is that the recording pane's own row is published right now —
    // the deadline only records while its waiter is parked — which establishes that THIS
    // environment has a published row. It does not establish that it has finished republishing,
    // so do not widen this further: a host that has published p1 but not yet p2 can still cost p2
    // its verdict. That residual is conservative — drop, re-park, hold longer, never resume early.
    if (staleKey.startsWith(prefix) && !liveTabs.has(staleKey.slice(prefix.length))) {
      expiredGenerationByPane.delete(staleKey)
    }
  }
  // Record BEFORE release using the waiter’s park-time identity; fresh binding reads could assign this wait to a replacement pane. Generation checks are independent; capped eviction merely adds another wait.
  if (!expiredGenerationByPane.has(key)) {
    while (expiredGenerationByPane.size >= MAX_EXPIRED_HANDLE_GAP_VERDICTS) {
      const oldest = expiredGenerationByPane.keys().next()
      if (oldest.done) {
        break
      }
      expiredGenerationByPane.delete(oldest.value)
    }
  }
  expiredGenerationByPane.set(key, {
    generation,
    paneBinding: waitersByPane.get(key)?.paneBinding ?? ''
  })
  // The landed-handle drain has to keep watching after this waiter is released.
  startStoreSubscription()
}

/** A published handle ends the measured gap; layout bindings preserve identity across gaps and cannot detect this transition. */
function retireVerdictsWithLandedHandles(state: HandleGapStoreState): void {
  for (const key of expiredGenerationByPane.keys()) {
    const tabId = key.slice(key.indexOf('\0') + 1)
    if ((state.ptyIdsByTabId[tabId]?.length ?? 0) > 0) {
      expiredGenerationByPane.delete(key)
    }
  }
}

function stopStoreSubscriptionIfIdle(): void {
  // Verdicts count: the landed-handle drain observes a transition no waiter is parked for.
  if (waitersByPane.size === 0 && expiredGenerationByPane.size === 0 && unsubscribeStore) {
    unsubscribeStore()
    unsubscribeStore = null
  }
}

function releaseWaiter(key: string): void {
  const waiter = waitersByPane.get(key)
  if (!waiter) {
    return
  }
  clearTimeout(waiter.deadline)
  waitersByPane.delete(key)
  stopStoreSubscriptionIfIdle()
  try {
    waiter.run()
  } catch (error) {
    // Isolate replay throws so synchronous store notification can continue to sibling waiters and later subscribers; this pane is already unparked.
    console.warn('[host-mirror-handle-gap] parked resume replay failed:', error)
  }
}

function waiterIsReleased(waiter: HandleGapWaiter, state: HandleGapStoreState): boolean {
  if ((state.ptyIdsByTabId[waiter.tabId]?.length ?? 0) > 0) {
    return true
  }
  const tabs = state.tabsByWorktree[waiter.worktreeId] ?? []
  return !tabs.some((tab) => tab.id === waiter.tabId)
}

function releaseDueWaiters(state: HandleGapStoreState): void {
  // Snapshot due waiters because replay can re-park; new waits belong to the next store write.
  const due: [string, HandleGapWaiter][] = []
  for (const [key, waiter] of waitersByPane) {
    if (waiterIsReleased(waiter, state)) {
      due.push([key, waiter])
    }
  }
  // Replay can synchronously re-enter Zustand; check both waiter identity and current eligibility.
  for (const [key, waiter] of due) {
    // Nested replay may replace this waiter; releasing by key would replay the new wait twice for one write.
    if (waitersByPane.get(key) !== waiter) {
      continue
    }
    // Adoption can mutate the same waiter’s workspace, invalidating earlier retraction evidence. Recheck live state conservatively; stale evidence could release a republished pane (#19735).
    if (!waiterIsReleased(waiter, useAppStore.getState())) {
      continue
    }
    releaseWaiter(key)
  }
}

function startStoreSubscription(): void {
  if (unsubscribeStore) {
    return
  }
  let { ptyIdsByTabId: previousPtyIdsByTabId, tabsByWorktree: previousTabsByWorktree } =
    useAppStore.getState()
  unsubscribeStore = useAppStore.subscribe((state) => {
    // Only tab/PTY slices can release waits; title/status/usage churn must not rescan them.
    if (
      state.ptyIdsByTabId === previousPtyIdsByTabId &&
      state.tabsByWorktree === previousTabsByWorktree
    ) {
      return
    }
    previousPtyIdsByTabId = state.ptyIdsByTabId
    previousTabsByWorktree = state.tabsByWorktree
    retireVerdictsWithLandedHandles(state)
    releaseDueWaiters(state)
    stopStoreSubscriptionIfIdle()
  })
}

/** Replay on handle, retraction or deadline; re-parking replaces run without extending the original deadline. */
export function parkUntilHostMirrorHandleLands(
  environmentId: string,
  worktreeId: string,
  tabId: string,
  run: () => void
): void {
  const key = paneWaitKey(environmentId, tabId)
  const existing = waitersByPane.get(key)
  if (existing) {
    existing.run = run
    // Move workspace with the replay after orphan adoption, but retain park-time pane identity so old-workspace retraction cannot release it.
    existing.worktreeId = worktreeId
    return
  }
  const generation = getRuntimeEnvironmentConnectionGeneration(environmentId)
  const deadline = setTimeout(() => {
    // Require unchanged generation/contact epoch and current contact: disconnect may preserve generation, and brief recovered outages still invalidate the budget. Release without verdict to re-park; silence never proves exit (#19735).
    const waiter = waitersByPane.get(key)
    if (
      !environmentContactIsLost(environmentId) &&
      waiter?.generation === getRuntimeEnvironmentConnectionGeneration(environmentId) &&
      waiter.contactEpoch === hostContactEpochFor(environmentId)
    ) {
      recordExpiredWait(environmentId, key)
    }
    releaseWaiter(key)
  }, HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)
  waitersByPane.set(key, {
    worktreeId,
    tabId,
    generation,
    contactEpoch: hostContactEpochFor(environmentId),
    paneBinding: paneBindingFor(tabId, environmentId),
    deadline,
    run
  })
  startStoreSubscription()
}

export function countParkedHostMirrorHandleGapPanesForTests(): number {
  return waitersByPane.size
}

/** Teardown clears verdicts but preserves bounded recovery waiters, as clearHostSessionMirrorHydration does; re-pair replaces evidence without canceling owed replay. */
export function clearHostMirrorHandleGapVerdictsForEnvironment(environmentId: string): void {
  const prefix = `${environmentId}\0`
  for (const key of expiredGenerationByPane.keys()) {
    if (key.startsWith(prefix)) {
      expiredGenerationByPane.delete(key)
    }
  }
  // The landed-handle drain may have been the only thing holding the subscription open.
  stopStoreSubscriptionIfIdle()
}

export function countHostMirrorHandleGapVerdictsForTests(): number {
  return expiredGenerationByPane.size
}

export function resetHostMirrorHandleGapWaitsForTests(): void {
  for (const waiter of waitersByPane.values()) {
    clearTimeout(waiter.deadline)
  }
  waitersByPane.clear()
  expiredGenerationByPane.clear()
  unsubscribeStore?.()
  unsubscribeStore = null
}
