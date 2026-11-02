import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
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
import { makeTerminalTab } from '../store/slices/worktrees-slice-test-fixtures'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'

/** Verify composition: same-environment tab death, environment teardown, global stale-generation pruning and read-time pane identity. Retain verdicts for live/genuine reattached panes so expiry cannot re-park forever. */

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
  const layouts: Record<string, TerminalLayoutSnapshot> = {}
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
    tabsByWorktree: {
      [WORKTREE]: tabIds.map((id) => makeTerminalTab({ id, worktreeId: WORKTREE, title: id }))
    },
    terminalLayoutsByTabId: layouts,
    ptyIdsByTabId: {}
  })
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

    // Reused tab ID is a new pane only because its environment-minted PTY binding changed.
    setLiveTabs(['a2', 'reused'], { reused: `remote:${ENV_A}@@term_freshly_minted` })
    parkAndExpire(ENV_A, 'a2')

    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'a1')).toBe(false)
    expect(hasHostMirrorHandleWaitExpired(ENV_B, 'b1')).toBe(false)
    // The read-time generation gate alone returns false; only retained-entry COUNT proves global pruning ran.
    expect(hasHostMirrorHandleWaitExpired(ENV_C, 'c1')).toBe(false)

    // A reused live tab defeats death/teardown triggers; compare its park-time binding at read time to deny another pane’s verdict.
    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'reused')).toBe(false)

    expect(countHostMirrorHandleGapVerdictsForTests()).toBe(2)
  })

  it('answers for a genuine reattach that still holds the same PTY', () => {
    // Same-PTY reattach must inherit its verdict or identity checks would remove the expiry loop-breaker.
    setRuntimeEnvironmentConnectionGenerationForTests(ENV_A, 1)
    setLiveTabs(['a1'])
    parkAndExpire(ENV_A, 'a1')
    setLiveTabs([])
    setLiveTabs(['a1'])
    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'a1')).toBe(true)
  })

  it('records the binding the pane held at PARK time, not at expiry', () => {
    // Rebind between park and expiry to catch reading current identity instead of the waiter’s original binding.
    setRuntimeEnvironmentConnectionGenerationForTests(ENV_A, 1)
    setLiveTabs(['a1'])
    parkUntilHostMirrorHandleLands(ENV_A, WORKTREE, 'a1', () => {})
    setLiveTabs(['a1'], { a1: `remote:${ENV_A}@@term_replacement` })
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS + 1)

    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'a1')).toBe(false)
  })

  it('refuses to answer on an empty binding, which is a match value and not a null', () => {
    // Two empty bindings must never match; verify the production park predicate uses the same environment-PTY test, but retain the defensive empty-value refusal.
    setRuntimeEnvironmentConnectionGenerationForTests(ENV_A, 1)
    setLiveTabs(['a1'], { a1: 'remote:some-other-env@@term_1' })
    parkAndExpire(ENV_A, 'a1')
    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'a1')).toBe(false)
  })

  it('keeps a verdict sticky enough to break the park/expire/replay loop', () => {
    // Live/current verdicts must stay sticky or each replay re-parks with a fresh budget forever.
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
    // Only env-b is temporarily rowless while env-a records; its surviving verdict proves tab-death pruning stays environment-scoped.
    for (const environmentId of [ENV_A, ENV_B, ENV_C]) {
      setRuntimeEnvironmentConnectionGenerationForTests(environmentId, 1)
    }
    setLiveTabs(['a1', 'a2', 'b1', 'c1'])
    parkAndExpire(ENV_A, 'a1')
    parkAndExpire(ENV_B, 'b1')
    parkAndExpire(ENV_C, 'c1')

    setLiveTabs(['a1', 'a2', 'c1'])
    parkAndExpire(ENV_A, 'a2')
    setLiveTabs(['a1', 'a2', 'b1', 'c1'])

    expect(hasHostMirrorHandleWaitExpired(ENV_B, 'b1')).toBe(true)
    expect(hasHostMirrorHandleWaitExpired(ENV_C, 'c1')).toBe(true)
    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'a1')).toBe(true)
  })

  it('holds the verdict map at one live row per environment under churn', () => {
    for (let round = 0; round < 300; round += 1) {
      const environmentId = [ENV_A, ENV_B, ENV_C][round % 3]!
      setRuntimeEnvironmentConnectionGenerationForTests(environmentId, round + 1)
      // Bind each round to its recording environment so retention fixtures represent reachable non-empty pane identities.
      setLiveTabs([`tab-${round}`], { [`tab-${round}`]: `remote:${environmentId}@@term_${round}` })
      parkAndExpire(environmentId, `tab-${round}`)
    }

    // Count BEFORE teardown: 300 expiries must retain only one verdict per environment. This proves pruning runs; the simultaneous orphan test separately isolates the generation rule.
    expect(countHostMirrorHandleGapVerdictsForTests()).toBe(3)

    for (const environmentId of [ENV_A, ENV_B, ENV_C]) {
      clearHostMirrorHandleGapVerdictsForEnvironment(environmentId)
    }
    expect(countHostMirrorHandleGapVerdictsForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds permanently orphaned verdicts across distinct environments', () => {
    for (let round = 0; round < 600; round += 1) {
      const environmentId = `env-orphan-${round}`
      setRuntimeEnvironmentConnectionGenerationForTests(environmentId, 1)
      const tabId = `orphan-${round}`
      setLiveTabs([tabId], { [tabId]: `remote:${environmentId}@@term_${round}` })
      parkAndExpire(environmentId, tabId)
    }

    expect(countHostMirrorHandleGapVerdictsForTests()).toBeLessThanOrEqual(512)
  })
})
