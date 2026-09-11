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

  beforeEach(() => {
    vi.useFakeTimers()
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
  })

  afterEach(() => {
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
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

  // The residual hazard, recorded rather than fixed: the verdict is keyed on a tab id and is
  // deliberately sticky for the life of the connection, so a pane whose row is retracted keeps its
  // verdict. If the host ever republishes that same tab id on the same connection, the new pane
  // inherits "your wait already expired" and skips its own — which is the #19735 shape. Clearing on
  // re-park would remove the loop-breaker, so this is pinned as behaviour, not changed.
  //
  // The tab-death prune does NOT close this, which both its author and I initially assumed it did;
  // they measured it and told us otherwise. The reason is the trigger, not the predicate: the prune
  // runs only inside `recordExpiredWait`, so it fires on the next expiry IN THAT ENVIRONMENT. Reuse
  // the id before then and the entry is never swept — and once the id is republished the predicate
  // stops matching it at all, because the tab is live again. So it is not even eventually
  // consistent for this case. Closing it needs a trigger that fires on row retraction itself.
  // Do not delete this test on the strength of that prune landing.
  it('keeps a retracted pane’s verdict, so a reused tab id inherits it', () => {
    setRuntimeEnvironmentConnectionGenerationForTests('env-a', 1)
    parkUntilHostMirrorHandleLands('env-a', 'wt-1', 'tab-a', () => {})
    expire()
    expect(hasHostMirrorHandleWaitExpired('env-a', 'tab-a')).toBe(true)

    parkUntilHostMirrorHandleLands('env-a', 'wt-1', 'tab-a', () => {})
    expect(hasHostMirrorHandleWaitExpired('env-a', 'tab-a')).toBe(true)
  })
})
