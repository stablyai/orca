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
 *
 * Sustained reconnect churn can therefore hold a pane parked indefinitely: each reconnect voids the
 * in-flight verdict and grants a fresh full budget. That is CORRECT, not the defect above. Under
 * churn the pane's liveness genuinely is unverifiable, and `docs/reference/ssh-execution-boundary.md`
 * forbids resolving unverifiable to `exited`. It has the shape of a latch that never releases, so
 * do not "fix" it by letting a verdict from one connection decide another — that is #19735.
 */
export const HOST_MIRROR_HANDLE_GAP_DEADLINE_MS = WEB_SESSION_TAB_RPC_TIMEOUT_MS

type HandleGapWaiter = {
  worktreeId: string
  tabId: string
  /** Connection generation the wait was armed on; its verdict is void on any other. */
  generation: number
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
/**
 * Connection generation whose wait already expired for the pane.
 *
 * THREE drains, with three different triggers. Getting the scopes right is the whole design; see
 * `recordExpiredWait` for why the first two must NOT share a scope.
 *  - superseded generation: per key, EVERY environment. Runs on any recording, anywhere.
 *  - dead tab row: the recording environment ONLY. Runs on a recording in that environment.
 *  - removed environment: `clearHostMirrorHandleGapVerdictsForEnvironment`, on teardown. The only
 *    trigger that fires at all for an environment that will never record again. A row stranded
 *    there is inert — removal advances the generation, so it can never match — so that one is a
 *    leak fix, not a correctness fix.
 *
 * ONE CLASS IS STILL UNCOVERED, and unlike the rest it is NOT conservative: a retracted tab id
 * that is republished inherits the old pane's verdict and skips its own wait, which is the #19735
 * direction rather than a longer hold. No trigger above reaches it — the dead-row predicate stops
 * matching once the id is live again, teardown is the wrong event, and a pane holding a verdict
 * never parks, so no waiter observes the retraction. Closing it needs a fourth trigger, on row
 * retraction. Pinned in host-mirror-handle-gap-verdict-union.test.ts; do not delete that case.
 */
type ExpiredHandleGapVerdict = {
  generation: number
  /** Sorted environment-minted PTY ids the tab's leaves held AT PARK TIME; '' when none. */
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
    .join('')
}

/** True once the deadline fired for THIS pane on the current connection. */
export function hasHostMirrorHandleWaitExpired(environmentId: string, tabId: string): boolean {
  const verdict = expiredGenerationByPane.get(paneWaitKey(environmentId, tabId))
  if (verdict === undefined || verdict.paneBinding === '') {
    // Why '' never answers: it is a MATCH VALUE, not a null. Two different panes that both hold no
    // environment-minted PTY compare equal, which is the reused-tab-id inheritance this check
    // exists to stop, in a narrower window. Unreachable through the production park path —
    // `findUnhydratedHostMirrorForPane` only reports `kind: 'handle'` when
    // `tabHoldsEnvironmentPtyBinding` finds a binding, reading the same map through the same
    // predicate as `paneBindingFor` — and pinned by the coupling test in
    // host-mirror-handle-gap-verdict-union.test.ts. Refusing costs a re-park, which is the
    // conservative direction, so the pair stays safe even if those two reads ever drift apart.
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

function recordExpiredWait(environmentId: string, key: string): void {
  const generation = getRuntimeEnvironmentConnectionGeneration(environmentId)
  // TWO rules with DIFFERENT scopes, deliberately. Flattening them to one scope is wrong either
  // way round, and both wrong shapes were independently written before this was reconciled.
  const prefix = `${environmentId}\0`
  const liveTabs = liveTabIds()
  for (const [staleKey, stale] of expiredGenerationByPane) {
    // GENERATION, judged per key across EVERY environment. `hasHostMirrorHandleWaitExpired`
    // compares a row against its own environment's CURRENT generation, so a row whose generation
    // has moved can never return true for anyone. Retiring it cannot cost a reader a verdict,
    // whoever owns it. Scoped to the recording environment, an environment that reconnects and
    // then goes quiet strands its rows forever.
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
  // Why the waiter's park-time binding and not a fresh read: this verdict is about the pane whose
  // wait just ran out. Re-reading here would attribute it to whatever holds the id NOW, handing a
  // pane that replaced it mid-wait a verdict it never served. The caller must therefore record
  // BEFORE `releaseWaiter` deletes the entry; the union suite pins that ordering.
  expiredGenerationByPane.set(key, {
    generation,
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
  try {
    waiter.run()
  } catch (error) {
    // Why: one write releases every due pane, and the drain runs inside the store subscriber. The
    // panes in it are strangers to each other and to the frame that published the handle, so an
    // unguarded replay throw both strands every pane queued behind it and surfaces at the mirror
    // apply's own `setState`. The pane is already unparked here; only its replay is lost.
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
  waitersByPane.set(key, {
    worktreeId,
    tabId,
    generation,
    paneBinding: paneBindingFor(tabId, environmentId),
    deadline,
    run
  })
  startStoreSubscription()
}

export function countParkedHostMirrorHandleGapPanesForTests(): number {
  return waitersByPane.size
}

/**
 * Drops the verdicts an environment's teardown makes unreachable.
 *
 * Only the verdicts. Parked waiters deliberately survive, matching
 * `clearHostSessionMirrorHydration`: a re-pair or effect restart replaces the connection's
 * evidence, it does not cancel the recovery this client still owes the pane. A waiter left here is
 * bounded by its own deadline and replays the sweep exactly as it would have.
 */
export function clearHostMirrorHandleGapVerdictsForEnvironment(environmentId: string): void {
  const prefix = `${environmentId}\0`
  for (const key of expiredGenerationByPane.keys()) {
    if (key.startsWith(prefix)) {
      expiredGenerationByPane.delete(key)
    }
  }
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
