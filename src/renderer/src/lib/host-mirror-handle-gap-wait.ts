import { useAppStore } from '@/store'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { WEB_SESSION_TAB_RPC_TIMEOUT_MS } from '@/runtime/web-session-tab-rpc-timeout'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'

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
  /** Identifies the pane this wait is about; see ExpiredHandleGapVerdict. */
  paneBinding: string
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
 * Sticky is not the same as "applies to whatever later holds this tab id". The key is a tab id,
 * which is NOT unique over a connection — `createTab` honours caller-supplied id hints and orphan
 * adoption re-keys rows — so a pane republished under a retired pane's id used to inherit "your
 * wait already expired" and skip its own wait. That is the #19735 direction, and it is the one
 * gap on this map that is not conservative: every other one drops a verdict and re-parks, which
 * only ever holds longer.
 *
 * It is closed by identifying the PANE the verdict was about rather than by pruning, so no new
 * trigger is needed — which matters, because every trigger any owner of this map controls fires
 * downstream of the moment this hazard needs. The verdict carries the environment-minted PTY
 * binding the pane held when it parked, and only answers for a pane that still holds it:
 *
 *  - a republished pane binds a PTY the host newly minted, so the binding differs and it gets its
 *    own wait;
 *  - a genuinely reattached pane holding the same PTY inherits the verdict, which is correct — the
 *    verdict follows the PTY, not the tab id;
 *  - a transient rowless frame does not touch the binding, so the verdict survives it. That is the
 *    case that makes a retraction-triggered prune unsafe and this read-time check safe.
 *
 * Bounded by the panes that have parked AND expired on each environment's current connection;
 * every environment's rows are retired on its own next reconnect, by any expiry anywhere.
 */
type ExpiredHandleGapVerdict = {
  generation: number
  /** Sorted environment-minted PTY ids the tab's leaves held at park time; '' when none. */
  paneBinding: string
}
const expiredGenerationByPane = new Map<string, ExpiredHandleGapVerdict>()
let unsubscribeStore: (() => void) | null = null

function paneWaitKey(environmentId: string, tabId: string): string {
  return `${environmentId}\0${tabId}`
}

/**
 * The environment-minted PTY ids this tab's leaves are bound to, as one comparable string.
 *
 * Read from the layout, not `ptyIdsByTabId`: during the handle gap the published-handle map is
 * empty by definition — that is the gap — while the layout binding is what
 * `tabHoldsEnvironmentPtyBinding` already uses to call the pane unverifiable rather than dead.
 */
function paneBindingFor(tabId: string, environmentId: string): string {
  const bindings = useAppStore.getState().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
  return Object.values(bindings)
    .filter(
      (ptyId): ptyId is string =>
        typeof ptyId === 'string' && parseRemoteRuntimePtyId(ptyId)?.environmentId === environmentId
    )
    .sort()
    .join('')
}

/** True once the deadline fired for THIS pane on the current connection. */
export function hasHostMirrorHandleWaitExpired(environmentId: string, tabId: string): boolean {
  const verdict = expiredGenerationByPane.get(paneWaitKey(environmentId, tabId))
  return (
    verdict !== undefined &&
    verdict.generation === getRuntimeEnvironmentConnectionGeneration(environmentId) &&
    // Why this and not the key alone: the key is a tab id, and the pane behind it can be replaced.
    verdict.paneBinding === paneBindingFor(tabId, environmentId)
  )
}

function recordExpiredWait(environmentId: string, key: string): void {
  // Why every environment and not just this one: a verdict is dead weight once its own environment
  // reconnects, but only an expiry INSIDE that environment used to look at it — so a quiet or
  // removed environment, which by definition expires nothing again, retained its rows for the life
  // of the process. Each key names its own environment, so the generation it must be judged against
  // is readable from the key.
  for (const [staleKey, stale] of expiredGenerationByPane) {
    const staleEnvironmentId = staleKey.slice(0, staleKey.indexOf('\0'))
    if (getRuntimeEnvironmentConnectionGeneration(staleEnvironmentId) !== stale.generation) {
      expiredGenerationByPane.delete(staleKey)
    }
  }
  // Why the waiter's park-time binding and not a fresh read: this verdict is about the pane whose
  // wait just ran out, and re-reading here would attribute it to whatever holds the id now.
  expiredGenerationByPane.set(key, {
    generation: getRuntimeEnvironmentConnectionGeneration(environmentId),
    paneBinding: waitersByPane.get(key)?.paneBinding ?? ''
  })
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
  waitersByPane.set(key, {
    worktreeId,
    tabId,
    paneBinding: paneBindingFor(tabId, environmentId),
    deadline,
    run
  })
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
