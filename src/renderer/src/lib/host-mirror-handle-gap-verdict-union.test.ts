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
 *   D  REUSED tab id                          read-time pane identity, NOT a prune
 *
 * D is the one that needed no new trigger: every trigger the other three own fires downstream of
 * the moment it needs. The verdict instead carries the PTY binding its pane held AT PARK TIME and
 * only answers for a pane that still holds it.
 *
 * Plus the properties no rule may break: the verdict stays sticky enough to break the
 * park/expire/replay loop, a genuine reattach still inherits, and no rule evicts a verdict a live
 * pane still needs.
 */

const ENV_A = 'env-union-a'
const ENV_B = 'env-union-b'
const ENV_C = 'env-union-c'
const WORKTREE = 'repo-1::wt-union'
const initialAppStoreState = useAppStore.getState()

/** Which environment minted each pane's PTY; the binding only counts for its own environment. */
const ENV_OF_TAB: Record<string, string> = {
  a1: ENV_A,
  a2: ENV_A,
  reused: ENV_A,
  b1: ENV_B,
  c1: ENV_C
}

/** Publishes rows AND the layout PTY binding each pane holds — the binding is the pane's identity. */
function setLiveTabs(tabIds: string[], ptyByTabId: Record<string, string> = {}): void {
  const layouts: Record<string, unknown> = {}
  for (const id of tabIds) {
    const ptyId = ptyByTabId[id] ?? `remote:${ENV_OF_TAB[id] ?? ENV_A}@@term_${id}`
    layouts[id] = {
      root: { type: 'leaf', leafId: `leaf-${id}` },
      activeLeafId: `leaf-${id}`,
      expandedLeafId: null,
      ptyIdsByLeafId: { [`leaf-${id}`]: ptyId }
    }
  }
  useAppStore.setState({
    tabsByWorktree: { [WORKTREE]: tabIds.map((id) => ({ id, title: id, ptyId: null })) },
    terminalLayoutsByTabId: layouts,
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

    // A's tab closes; the reused id is retracted and republished as a DIFFERENT pane, which binds
    // a PTY the host newly minted. That new binding is what makes it a different pane, not the id.
    setLiveTabs(['a2', 'reused'], { reused: `remote:${ENV_A}@@term_freshly_minted` })
    parkAndExpire(ENV_A, 'a2')

    // A drained: a1's row is gone and env-a recorded again, so the tab-death rule swept it.
    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'a1')).toBe(false)
    // B drained: by teardown, which is the only trigger that fires for a removed environment.
    expect(hasHostMirrorHandleWaitExpired(ENV_B, 'b1')).toBe(false)
    // C drained: env-a's expiry retired env-c's superseded row, though env-c never expired again.
    expect(hasHostMirrorHandleWaitExpired(ENV_C, 'c1')).toBe(false)

    // D is closed, and NOT by a prune. No trigger any rule above owns fires at the right moment:
    // the tab-death predicate stops matching once the id is live again, teardown is the wrong
    // event, and no waiter observes the retraction because a pane holding a verdict never parks.
    // It is closed at READ time instead — the verdict names the pane it was about, so a pane that
    // binds a newly minted PTY does not answer to it and serves its own wait.
    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'reused')).toBe(false)

    // Only the two live verdicts survive: a2's and the stranded reused-id row.
    expect(countHostMirrorHandleGapVerdictsForTests()).toBe(2)
  })

  it('answers for a genuine reattach that still holds the same PTY', () => {
    // The verdict follows the PTY, not the tab id. A pane that reattaches to the SAME environment
    // PTY is the same pane, so it must inherit — otherwise the identity check would have quietly
    // removed the loop-breaker for every reattach.
    setRuntimeEnvironmentConnectionGenerationForTests(ENV_A, 1)
    setLiveTabs(['a1'])
    parkAndExpire(ENV_A, 'a1')
    setLiveTabs([])
    setLiveTabs(['a1'])
    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'a1')).toBe(true)
  })

  it('records the binding the pane held at PARK time, not at expiry', () => {
    // The mutation this kills: reading the binding inside `recordExpiredWait` from the store
    // instead of from the waiter. A pane replaced mid-wait leaves the original waiter running to
    // term, and an expiry-time read would attribute the verdict to whoever holds the id by then —
    // handing the new pane a wait it never served. Three earlier cases all survived that bug;
    // only rebinding BETWEEN park and expire distinguishes the two implementations.
    setRuntimeEnvironmentConnectionGenerationForTests(ENV_A, 1)
    setLiveTabs(['a1'])
    parkUntilHostMirrorHandleLands(ENV_A, WORKTREE, 'a1', () => {})
    setLiveTabs(['a1'], { a1: `remote:${ENV_A}@@term_replacement` })
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS + 1)

    // The replacement pane never served this wait, so it must not inherit its verdict.
    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'a1')).toBe(false)
  })

  it('refuses to answer on an empty binding, which is a match value and not a null', () => {
    // '' is what `paneBindingFor` returns when no leaf holds an environment-minted PTY. Two
    // different panes both reading '' would compare EQUAL and inherit, which is the reused-tab-id
    // shape again. Measured unreachable through the production park path rather than assumed: the
    // only route into `parkUntilHostMirrorHandleLands` is `kind: 'handle'`, which
    // `findUnhydratedHostMirrorForPane` reports only when `tabHoldsEnvironmentPtyBinding`
    // (host-mirrored-pane-liveness.ts:28-31) finds a match — the SAME `terminalLayoutsByTabId`
    // map through the SAME `parseRemoteRuntimePtyId` predicate `paneBindingFor` uses, so a pane
    // that would bind '' never parks. It must still refuse rather than match, because that
    // coupling is two functions in two files and nothing enforces it.
    setRuntimeEnvironmentConnectionGenerationForTests(ENV_A, 1)
    setLiveTabs(['a1'], { a1: 'remote:some-other-env@@term_1' })
    parkAndExpire(ENV_A, 'a1')
    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'a1')).toBe(false)
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
