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
/**
 * Connection generation whose wait already expired for the pane.
 *
 * Sticky for the life of that connection on purpose: this is the loop-breaker. A replayed sweep
 * re-asks about the same pane, and without a recorded verdict it would park, expire and replay
 * forever. So it is NOT cleared when the pane's row is retracted.
 *
 * The cost of that, and the reason it is written down: the key is a tab id, and a tab id is not
 * guaranteed unique over a connection — `createTab` honours caller-supplied id hints and orphan
 * adoption re-keys rows. A pane republished under a retired pane's tab id inherits "your wait
 * already expired" and skips its own wait, which is the #19735 shape. Fixing it by clearing on
 * re-park would remove the loop-breaker, so it is pinned in
 * host-mirror-handle-gap-wait-retention.test.ts rather than traded away.
 *
 * Bounded by the panes that have parked AND expired on each environment's current connection;
 * every environment's rows are retired on its own next reconnect, by any expiry anywhere.
 */
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

function recordExpiredWait(environmentId: string, key: string): void {
  // Why every environment and not just this one: a verdict is dead weight once its own environment
  // reconnects, but only an expiry INSIDE that environment used to look at it — so a quiet or
  // removed environment, which by definition expires nothing again, retained its rows for the life
  // of the process. Each key names its own environment, so the generation it must be judged against
  // is readable from the key.
  for (const [staleKey, staleGeneration] of expiredGenerationByPane) {
    const staleEnvironmentId = staleKey.slice(0, staleKey.indexOf('\0'))
    if (getRuntimeEnvironmentConnectionGeneration(staleEnvironmentId) !== staleGeneration) {
      expiredGenerationByPane.delete(staleKey)
    }
  }
  expiredGenerationByPane.set(key, getRuntimeEnvironmentConnectionGeneration(environmentId))
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
