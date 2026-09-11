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
  /** Connection generation the wait was armed on; its verdict is void on any other. */
  generation: number
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

function tabIdFromPaneWaitKey(key: string): string {
  return key.slice(key.indexOf('\0') + 1)
}

/** True once the deadline fired for this pane on the current connection. */
export function hasHostMirrorHandleWaitExpired(environmentId: string, tabId: string): boolean {
  return (
    expiredGenerationByPane.get(paneWaitKey(environmentId, tabId)) ===
    getRuntimeEnvironmentConnectionGeneration(environmentId)
  )
}

function recordExpiredWait(environmentId: string, key: string): void {
  const generation = getRuntimeEnvironmentConnectionGeneration(environmentId)
  // Why: a verdict from a previous connection is dead weight; drop it so the map
  // stays bounded by the panes parked on the current connection.
  const prefix = `${environmentId}\0`
  for (const [staleKey, staleGeneration] of expiredGenerationByPane) {
    if (staleKey.startsWith(prefix) && staleGeneration !== generation) {
      expiredGenerationByPane.delete(staleKey)
    }
  }
  expiredGenerationByPane.set(key, generation)
  // Why the subscription outlives the waiter: the verdict below has to be retired when a handle
  // lands, and by then the waiter is gone.
  startStoreSubscription()
}

/**
 * A landed handle retires the timeout verdict for its pane.
 *
 * Why this is needed at all: the module's own premise was "a reconnect bumps the connection
 * generation and arms a fresh wait", and the #19647 change in this same stack stops recording
 * `status: null` for an unreachable host — so `connectionChanged` no longer fires across an
 * outage on the same runtime. Without this the first timeout stuck for the rest of the
 * generation, and the NEXT handle gap on that pane got no wait at all: straight back to the
 * #19735 fork, with the bounded wait removed rather than merely shortened. A published handle is
 * positive host evidence and ends the gap episode the deadline was about.
 */
function retireExpiredWaitsWithLandedHandles(state: HandleGapStoreState): void {
  // Deleting the current entry mid-iteration is defined for Map, so no snapshot is needed.
  for (const key of expiredGenerationByPane.keys()) {
    if ((state.ptyIdsByTabId[tabIdFromPaneWaitKey(key)]?.length ?? 0) > 0) {
      expiredGenerationByPane.delete(key)
    }
  }
}

function stopStoreSubscriptionIfIdle(): void {
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
  // Why contained: the release path runs inside useAppStore.subscribe, so a replay that throws
  // escapes the setState that triggered it — aborting the listener loop, so every subscriber
  // after this one misses the write, and stranding the sibling panes the same frame made due.
  // The waiter's own state is already torn down above, so nothing is held by swallowing here.
  try {
    waiter.run()
  } catch (error) {
    console.error(`[host-mirror] parked resume replay failed for ${key}:`, error)
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
    retireExpiredWaitsWithLandedHandles(state)
    releaseDueWaiters(state)
    stopStoreSubscriptionIfIdle()
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
    // Why the worktree moves with `run`: adopting an orphaned terminal re-keys `tabsByWorktree`
    // without re-keying the record, so a live wait left on the old worktree released on evidence
    // about a workspace it is no longer about.
    existing.worktreeId = worktreeId
    return
  }
  const generation = getRuntimeEnvironmentConnectionGeneration(environmentId)
  const deadline = setTimeout(() => {
    // Why the generation is re-read: a reconnect mid-park makes this wait's silence
    // evidence about a connection that is gone. Recording it would let a wait armed
    // milliseconds before the reconnect authorize a resume on the new one — the #19735
    // fork with an extra step. Release without a verdict instead; the replay re-parks
    // and the new connection gets its own full budget.
    if (
      waitersByPane.get(key)?.generation ===
      getRuntimeEnvironmentConnectionGeneration(environmentId)
    ) {
      recordExpiredWait(environmentId, key)
    }
    releaseWaiter(key)
  }, HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)
  waitersByPane.set(key, { worktreeId, tabId, generation, deadline, run })
  startStoreSubscription()
}

export function countParkedHostMirrorHandleGapPanesForTests(): number {
  return waitersByPane.size
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
