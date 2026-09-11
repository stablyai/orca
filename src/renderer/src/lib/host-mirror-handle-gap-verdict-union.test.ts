import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  setRuntimeEnvironmentConnectionGenerationForTests
} from '@/store/slices/runtime-status'
import {
  HOST_MIRROR_HANDLE_GAP_DEADLINE_MS,
  clearHostMirrorHandleGapVerdictsForEnvironment,
  countHostMirrorHandleGapVerdictsForTests,
  hasHostMirrorHandleWaitExpired,
  parkUntilHostMirrorHandleLands,
  resetHostMirrorHandleGapWaitsForTests
} from './host-mirror-handle-gap-wait'

/**
 * The UNION suite for `expiredGenerationByPane`.
 *
 * Three agents changed this one map on three branches and each verified only their own. These
 * cases exist because nothing else proves the rules compose: individually-correct rules whose
 * interaction nobody tested is the exact failure this was looking for.
 *
 * Four orphan classes, and what covers each:
 *   A  tab churn on a LIVE environment        tab-death rule, recording environment only
 *   B  REMOVED environment                    clearHostMirrorHandleGapVerdictsForEnvironment
 *   C  cross-environment QUIESCENCE           generation rule, per key, every environment
 *   D  REUSED tab id                          NOTHING. Pinned below as a live hazard.
 *
 * Plus the two properties no rule may break: the verdict stays sticky enough to break the
 * park/expire/replay loop, and no rule evicts a verdict a live pane still needs.
 */

const ENV_A = 'env-union-a'
const ENV_B = 'env-union-b'
const ENV_C = 'env-union-c'
const WORKTREE = 'repo-1::wt-union'
const initialAppStoreState = useAppStore.getState()

function setLiveTabs(tabIds: string[]): void {
  useAppStore.setState({
    tabsByWorktree: { [WORKTREE]: tabIds.map((id) => ({ id, title: id, ptyId: null })) },
    ptyIdsByTabId: {}
  } as unknown as AppState)
}

function parkAndExpire(environmentId: string, tabId: string): void {
  parkUntilHostMirrorHandleLands(environmentId, WORKTREE, tabId, () => {})
  vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS + 1)
}

describe('handle-gap verdict map, all rules on one tree', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useAppStore.setState(initialAppStoreState, true)
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
  })

  afterEach(() => {
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    vi.useRealTimers()
  })

  it('handles all four orphan classes simultaneously', () => {
    for (const environmentId of [ENV_A, ENV_B, ENV_C]) {
      setRuntimeEnvironmentConnectionGenerationForTests(environmentId, 1)
    }
    setLiveTabs(['a1', 'a2', 'b1', 'c1', 'reused'])

    // A: tab churn on a live environment. a1 expires, then its tab closes.
    parkAndExpire(ENV_A, 'a1')
    // B: a whole environment that will be removed.
    parkAndExpire(ENV_B, 'b1')
    // C: an environment that will reconnect and then never expire another pane.
    parkAndExpire(ENV_C, 'c1')
    // D: a tab id that will be retracted and republished under the same id.
    parkAndExpire(ENV_A, 'reused')
    expect(countHostMirrorHandleGapVerdictsForTests()).toBe(4)

    // C reconnects and goes quiet. B's environment is removed outright.
    setRuntimeEnvironmentConnectionGenerationForTests(ENV_C, 2)
    clearHostMirrorHandleGapVerdictsForEnvironment(ENV_B)

    // A's tab closes; the reused id is retracted and republished as a DIFFERENT pane.
    setLiveTabs(['a2', 'reused'])
    parkAndExpire(ENV_A, 'a2')

    // A drained: a1's row is gone and env-a recorded again, so the tab-death rule swept it.
    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'a1')).toBe(false)
    // B drained: by teardown, which is the only trigger that fires for a removed environment.
    expect(hasHostMirrorHandleWaitExpired(ENV_B, 'b1')).toBe(false)
    // C drained: env-a's expiry retired env-c's superseded row, though env-c never expired again.
    expect(hasHostMirrorHandleWaitExpired(ENV_C, 'c1')).toBe(false)

    // D IS NOT DRAINED, and this assertion pins a LIVE HAZARD rather than a desired behaviour.
    // The republished pane inherits the retracted pane's verdict and skips its own wait.
    //
    // Why this one is different from every other gap argued over on this map: the others DROP a
    // verdict, so the pane re-parks and only ever holds longer. This one RETAINS a verdict and
    // lets a fresh pane resume on a handle that has not landed — the #19735 direction itself.
    // It is therefore the one gap here that is not conservative.
    //
    // No rule reaches it, and each for its own reason: the tab-death rule's predicate stops
    // matching the moment the id is republished, so it is not even eventually consistent; the
    // teardown drain fires on environment teardown, not on tab retraction inside a live one; and
    // no waiter exists to observe the retraction, because a pane holding a verdict never parks
    // (`findUnhydratedHostMirrorForPane` returns null on it). Closing it needs a fourth trigger,
    // on row retraction. DO NOT delete this case when a prune for dead tabs lands — "a prune for
    // dead tabs shipped" is exactly the plausible assumption that would delete it.
    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'reused')).toBe(true)

    // Only the two live verdicts survive: a2's and the stranded reused-id row.
    expect(countHostMirrorHandleGapVerdictsForTests()).toBe(2)
  })

  it('keeps a verdict sticky enough to break the park/expire/replay loop', () => {
    // The verdict exists to stop a pane re-parking forever. If any rule evicted it while the pane
    // is live and its connection current, the wait would rearm on a fresh budget every replay.
    setRuntimeEnvironmentConnectionGenerationForTests(ENV_A, 1)
    setLiveTabs(['a1'])
    parkAndExpire(ENV_A, 'a1')

    for (let replay = 0; replay < 20; replay += 1) {
      expect(hasHostMirrorHandleWaitExpired(ENV_A, 'a1')).toBe(true)
      parkAndExpire(ENV_A, 'a1')
    }
    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'a1')).toBe(true)
  })

  it('never evicts a live pane verdict, whichever environment sweeps', () => {
    // Three environments on purpose: with two at one generation the candidate rules are
    // indistinguishable and the naive "judge everything against the recording environment"
    // mutation survives. env-c is the discriminator — its verdict is live.
    for (const environmentId of [ENV_A, ENV_B, ENV_C]) {
      setRuntimeEnvironmentConnectionGenerationForTests(environmentId, 1)
    }
    setLiveTabs(['a1', 'a2', 'b1', 'c1'])
    parkAndExpire(ENV_A, 'a1')
    parkAndExpire(ENV_B, 'b1')
    parkAndExpire(ENV_C, 'c1')

    // env-b is briefly rowless mid-rehydration while env-a sweeps. Row absence is transient, so
    // this must not be read as retraction for an environment other than the one recording.
    setLiveTabs(['a1', 'a2', 'c1'])
    parkAndExpire(ENV_A, 'a2')
    setLiveTabs(['a1', 'a2', 'b1', 'c1'])

    expect(hasHostMirrorHandleWaitExpired(ENV_B, 'b1')).toBe(true)
    expect(hasHostMirrorHandleWaitExpired(ENV_C, 'c1')).toBe(true)
    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'a1')).toBe(true)
  })

  it('returns to baseline under churn across all three drains', () => {
    for (let round = 0; round < 300; round += 1) {
      const environmentId = [ENV_A, ENV_B, ENV_C][round % 3]!
      setRuntimeEnvironmentConnectionGenerationForTests(environmentId, round + 1)
      setLiveTabs([`tab-${round}`])
      parkAndExpire(environmentId, `tab-${round}`)
    }
    for (const environmentId of [ENV_A, ENV_B, ENV_C]) {
      clearHostMirrorHandleGapVerdictsForEnvironment(environmentId)
    }
    expect(countHostMirrorHandleGapVerdictsForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
