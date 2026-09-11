import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_MIRROR_HANDLE_GAP_DEADLINE_MS,
  countExpiredHostMirrorHandleGapVerdictsForTests,
  hasHostMirrorHandleWaitExpired,
  parkUntilHostMirrorHandleLands,
  resetHostMirrorHandleGapWaitsForTests
} from './host-mirror-handle-gap-wait'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  setRuntimeEnvironmentConnectionGenerationForTests
} from '@/store/slices/runtime-status'
import { useAppStore } from '@/store'

/**
 * What the expired-verdict map actually retains, as opposed to what its comment claimed.
 *
 * The verdict is deliberately sticky: it is the loop-breaker that stops a replayed sweep from
 * re-parking the same pane forever ("a handle that has not landed within the RPC budget is not
 * coming on this connection"). Sticky is right. What was wrong is the claim that dropping stale
 * generations keeps the map "bounded by the panes parked on the current connection" — the sweep
 * only ever looked at the environment currently recording an expiry, so no other environment's
 * rows were reachable by it, and an environment that never expires another pane never sweeps.
 */
describe('host-mirror handle-gap expired verdicts', () => {
  const expire = (): void => {
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS + 1)
  }

  /** The layout binding the liveness check reads — what identifies the pane behind a tab id. */
  const bindPane = (tabId: string, leafId: string, ptyId: string): void => {
    useAppStore.setState({
      terminalLayoutsByTabId: {
        ...useAppStore.getState().terminalLayoutsByTabId,
        [tabId]: {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: ptyId }
        } as never
      }
    } as never)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
  })

  afterEach(() => {
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    useAppStore.setState({ terminalLayoutsByTabId: {} } as never)
    vi.useRealTimers()
  })

  // The two halves have to be asserted together. Sweeping only the recording environment leaks
  // (first half); sweeping every row against the RECORDING environment's generation evicts a
  // verdict that is still live elsewhere (second half), which loses the loop-breaker for that
  // environment. Only judging each row against its OWN environment satisfies both.
  it('retires a reconnected environment’s rows from any expiry, and keeps a live one’s', () => {
    setRuntimeEnvironmentConnectionGenerationForTests('env-a', 1)
    setRuntimeEnvironmentConnectionGenerationForTests('env-b', 1)
    setRuntimeEnvironmentConnectionGenerationForTests('env-c', 1)
    parkUntilHostMirrorHandleLands('env-a', 'wt-1', 'tab-a', () => {})
    parkUntilHostMirrorHandleLands('env-b', 'wt-1', 'tab-b', () => {})
    parkUntilHostMirrorHandleLands('env-c', 'wt-1', 'tab-c', () => {})
    expire()
    expect(countExpiredHostMirrorHandleGapVerdictsForTests()).toBe(3)

    // env-a and env-b reconnect; env-c never does, so its verdict still describes a live connection.
    setRuntimeEnvironmentConnectionGenerationForTests('env-a', 2)
    setRuntimeEnvironmentConnectionGenerationForTests('env-b', 2)
    expect(hasHostMirrorHandleWaitExpired('env-b', 'tab-b')).toBe(false)
    expect(hasHostMirrorHandleWaitExpired('env-c', 'tab-c')).toBe(true)

    parkUntilHostMirrorHandleLands('env-a', 'wt-1', 'tab-a2', () => {})
    expire()

    // env-b is quiet and will never expire another pane of its own, so this expiry is the only
    // thing that can retire its dead row.
    expect(hasHostMirrorHandleWaitExpired('env-b', 'tab-b')).toBe(false)
    // env-c is on its original, still-live connection. Judging it against env-a's generation would
    // evict it and let env-c's sweep re-park a pane it had already given up on.
    expect(hasHostMirrorHandleWaitExpired('env-c', 'tab-c')).toBe(true)
    expect(countExpiredHostMirrorHandleGapVerdictsForTests()).toBe(2)
  })

  it('keeps the verdict for a pane on its own live connection', () => {
    setRuntimeEnvironmentConnectionGenerationForTests('env-a', 1)
    parkUntilHostMirrorHandleLands('env-a', 'wt-1', 'tab-a', () => {})
    expire()
    expect(hasHostMirrorHandleWaitExpired('env-a', 'tab-a')).toBe(true)

    // A second pane expiring on the SAME generation must not evict the first: the verdict is the
    // loop-breaker for its own pane, and losing it re-parks a sweep that already gave up.
    parkUntilHostMirrorHandleLands('env-a', 'wt-1', 'tab-a2', () => {})
    expire()
    expect(hasHostMirrorHandleWaitExpired('env-a', 'tab-a')).toBe(true)
    expect(hasHostMirrorHandleWaitExpired('env-a', 'tab-a2')).toBe(true)
    expect(countExpiredHostMirrorHandleGapVerdictsForTests()).toBe(2)
  })

  // The verdict stays sticky across a retraction — that is the loop-breaker — but it answers for
  // the PANE it was about, not for whatever later holds the tab id. Tab ids are not unique over a
  // connection (`createTab` honours caller-supplied id hints, orphan adoption re-keys rows), and
  // a republished pane inheriting "your wait already expired" skips its own wait, which is the
  // #19735 direction and the one gap here that is not conservative.
  //
  // No prune can close it, which is what makes the read-time check the right shape: every trigger
  // on this map fires downstream of the moment it needs. The tab-death prune runs only inside
  // `recordExpiredWait`, so it acts on the next expiry in that environment — reuse the id before
  // then and it never fires, and once republished its predicate stops matching because the tab is
  // live again. A retraction trigger is unsafe for a different reason: a transient rowless frame
  // would drop a sibling's still-valid verdict.
  it('answers for the pane it was about, not for a new pane under the same tab id', () => {
    setRuntimeEnvironmentConnectionGenerationForTests('env-a', 1)
    bindPane('tab-a', 'leaf-1', 'remote:env-a@@term_1')
    parkUntilHostMirrorHandleLands('env-a', 'wt-1', 'tab-a', () => {})
    expire()
    expect(hasHostMirrorHandleWaitExpired('env-a', 'tab-a')).toBe(true)

    // The host retracts that pane and republishes a different one under the same id: a PTY it
    // newly minted. The verdict must not carry over — this pane has never waited.
    bindPane('tab-a', 'leaf-1', 'remote:env-a@@term_2')
    expect(hasHostMirrorHandleWaitExpired('env-a', 'tab-a')).toBe(false)

    // A genuine reattach to the SAME pty inherits it, which is correct: the verdict follows the
    // PTY, not the tab id, and re-waiting on a pane that already gave up reopens the replay loop.
    bindPane('tab-a', 'leaf-1', 'remote:env-a@@term_1')
    expect(hasHostMirrorHandleWaitExpired('env-a', 'tab-a')).toBe(true)
  })

  // The narrow window the case above does not reach: the pane is replaced BETWEEN park and expiry.
  // A layout rebind is not a release condition (`waiterIsReleased` watches the handle map and the
  // rows, not the binding), so the original waiter runs to term and records a verdict — and the
  // verdict has to name the pane that actually did the waiting. Reading the binding at expiry
  // instead of at park time attributes it to whoever holds the id by then, which hands the new
  // pane a wait it never served. Both are green without this case, so it is the one that pins
  // WHICH moment the identity is captured at.
  it('records the pane that waited, not whatever holds the tab id when the deadline fires', () => {
    setRuntimeEnvironmentConnectionGenerationForTests('env-a', 1)
    bindPane('tab-a', 'leaf-1', 'remote:env-a@@term_1')
    parkUntilHostMirrorHandleLands('env-a', 'wt-1', 'tab-a', () => {})

    // Replaced mid-wait; nothing releases the waiter, so it still expires.
    bindPane('tab-a', 'leaf-1', 'remote:env-a@@term_2')
    expire()

    expect(hasHostMirrorHandleWaitExpired('env-a', 'tab-a')).toBe(false)
  })
})
