import { useAppStore } from '@/store'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { WEB_SESSION_TAB_RPC_TIMEOUT_MS } from '@/runtime/web-session-tab-rpc-timeout'

/**
 * Per-pane park for the frame between a host's tab rows and its PTY handles.
 *
 * Why: mirror hydration says "the rows arrived", not "this pane's liveness is
 * decidable" — the handle lands one relay round trip later. A pane whose leaf
 * is still bound to a PTY of the same environment, with no published handle,
 * is `unverifiable` (docs/reference/ssh-execution-boundary.md); resuming on it
 * forked a session the host was still running (#19735).
 *
 * The wait is bounded because mirror settlement has already happened and will
 * not replay a parked sweep again. Three exits, each replaying the sweep:
 *  - the pane's own handle lands (`ptyIdsByTabId[tabId]` non-empty);
 *  - the row is retracted (the host has spoken: the pane is gone);
 *  - the deadline expires. A handle that has not landed within the RPC budget
 *    is not coming on this connection, so the pane is released to ordinary
 *    recovery: a resume after a bounded wait is defensible, an indefinite hold
 *    is the latch-that-never-releases defect. A reconnect bumps the connection
 *    generation and arms a fresh wait.
 */
export const HOST_MIRROR_HANDLE_GAP_DEADLINE_MS = WEB_SESSION_TAB_RPC_TIMEOUT_MS

type HandleGapWaiter = {
  worktreeId: string
  tabId: string
  deadline: ReturnType<typeof setTimeout>
  run: () => void
}

type HandleGapStoreState = Pick<
  ReturnType<typeof useAppStore.getState>,
  'ptyIdsByTabId' | 'tabsByWorktree'
>

const waitersByPane = new Map<string, HandleGapWaiter>()
/** Connection generation whose wait already expired for the pane. */
const expiredGenerationByPane = new Map<string, number>()
let unsubscribeStore: (() => void) | null = null

function paneWaitKey(environmentId: string, tabId: string): string {
  return `${environmentId}\0${tabId}`
}

/** True once the deadline fired for this pane on the current connection. */
export function hasHostMirrorHandleWaitExpired(environmentId: string, tabId: string): boolean {
  return (
    expiredGenerationByPane.get(paneWaitKey(environmentId, tabId)) ===
    getRuntimeEnvironmentConnectionGeneration(environmentId)
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

function recordExpiredWait(environmentId: string, key: string): void {
  const generation = getRuntimeEnvironmentConnectionGeneration(environmentId)
  // Why two prune rules: a verdict from a previous connection is dead weight, and so is
  // one for a pane whose row is gone. Generation alone does not bound the map — a tab id
  // is never reissued, so a connection that never drops (the ordinary case for a session
  // left open for days) kept one entry for every pane that ever timed out.
  // Why both rules stay inside this environment: the caller's own row is published right now
  // (the deadline only records while its waiter is parked), which is what makes "no row" mean
  // "retracted" rather than "not re-published yet" — the same inference `waiterIsReleased`
  // already makes. That evidence covers only this environment. Sweeping others would drop a
  // verdict belonging to an environment that is merely mid-rehydration, and its pane would
  // re-park on a fresh full budget. Removed environments are left to teardown, not to this.
  //
  // Do not widen this on the assumption the inference is airtight: it establishes that this
  // environment has A published row, not that it has finished republishing. A host that has
  // published p1 and not yet p2 can still cost p2 its verdict here. That residual is
  // conservative in the same direction — drop, re-park, hold longer, never resume early.
  const prefix = `${environmentId}\0`
  const liveTabs = liveTabIds()
  for (const [staleKey, staleGeneration] of expiredGenerationByPane) {
    if (!staleKey.startsWith(prefix)) {
      continue
    }
    if (!liveTabs.has(staleKey.slice(prefix.length)) || staleGeneration !== generation) {
      expiredGenerationByPane.delete(staleKey)
    }
  }
  expiredGenerationByPane.set(key, generation)
}

function stopStoreSubscriptionIfIdle(): void {
  if (waitersByPane.size === 0 && unsubscribeStore) {
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
  waiter.run()
}

function waiterIsReleased(waiter: HandleGapWaiter, state: HandleGapStoreState): boolean {
  if ((state.ptyIdsByTabId[waiter.tabId]?.length ?? 0) > 0) {
    return true
  }
  const tabs = state.tabsByWorktree[waiter.worktreeId] ?? []
  return !tabs.some((tab) => tab.id === waiter.tabId)
}

function releaseDueWaiters(state: HandleGapStoreState): void {
  // Why: drain from a snapshot — a replay can re-park the pane, and that new
  // waiter belongs to the next store write, not this one.
  const dueKeys: string[] = []
  for (const [key, waiter] of waitersByPane) {
    if (waiterIsReleased(waiter, state)) {
      dueKeys.push(key)
    }
  }
  for (const key of dueKeys) {
    releaseWaiter(key)
  }
}

function startStoreSubscription(): void {
  if (unsubscribeStore) {
    return
  }
  let previous: HandleGapStoreState = useAppStore.getState()
  unsubscribeStore = useAppStore.subscribe((state) => {
    // Why: only these two slices can release a waiter; title, status, and
    // usage ticks must not rescan every parked pane.
    if (
      state.ptyIdsByTabId === previous.ptyIdsByTabId &&
      state.tabsByWorktree === previous.tabsByWorktree
    ) {
      return
    }
    previous = state
    releaseDueWaiters(state)
  })
}

/**
 * Parks `run` until the pane's handle lands, its row is retracted, or the
 * deadline expires. Re-parking an already-parked pane replaces `run` but keeps
 * the original deadline, so a replay that re-parks cannot extend the wait.
 */
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
    return
  }
  const deadline = setTimeout(() => {
    recordExpiredWait(environmentId, key)
    releaseWaiter(key)
  }, HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)
  waitersByPane.set(key, { worktreeId, tabId, deadline, run })
  startStoreSubscription()
}

export function countParkedHostMirrorHandleGapPanesForTests(): number {
  return waitersByPane.size
}

export function countExpiredHostMirrorHandleGapVerdictsForTests(): number {
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
