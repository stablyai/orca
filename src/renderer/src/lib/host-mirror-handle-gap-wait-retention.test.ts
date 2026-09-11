import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  setRuntimeEnvironmentConnectionGenerationForTests
} from '@/store/slices/runtime-status'
import {
  HOST_MIRROR_HANDLE_GAP_DEADLINE_MS,
  countExpiredHostMirrorHandleGapVerdictsForTests,
  countParkedHostMirrorHandleGapPanesForTests,
  hasHostMirrorHandleWaitExpired,
  parkUntilHostMirrorHandleLands,
  resetHostMirrorHandleGapWaitsForTests
} from './host-mirror-handle-gap-wait'

// What this pins: the two module-level maps here must return to baseline after churn.
// `waitersByPane` is drained by its deadline, but the expired-verdict map was pruned ONLY
// by connection generation — and a tab id is never reissued, so on a connection that never
// drops (a session left open for days, the ordinary case) every pane that ever timed out
// left a permanent entry. Both directions matter: under-pruning is the leak, and
// over-pruning drops a live pane's verdict and re-parks a wait that already answered.

const ENV_A = 'env-retention-a'
const ENV_B = 'env-retention-b'
const WORKTREE = 'repo-1::worktree-retention'
const initialAppStoreState = useAppStore.getState()

function setLiveTabs(tabIdsByWorktree: Record<string, string[]>): void {
  const tabsByWorktree: Record<string, unknown[]> = {}
  for (const [worktreeId, tabIds] of Object.entries(tabIdsByWorktree)) {
    tabsByWorktree[worktreeId] = tabIds.map((id) => ({ id, title: id, ptyId: null }))
  }
  useAppStore.setState({ tabsByWorktree, ptyIdsByTabId: {} } as unknown as AppState)
}

/** Parks a pane and lets its deadline fire, which is what records an expired verdict. */
function parkAndExpire(environmentId: string, worktreeId: string, tabId: string): void {
  parkUntilHostMirrorHandleLands(environmentId, worktreeId, tabId, () => {})
  vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS + 1)
}

describe('host mirror handle gap wait retention', () => {
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

  it('drains every waiter and its deadline timer once the budget expires', () => {
    setRuntimeEnvironmentConnectionGenerationForTests(ENV_A, 1)
    setLiveTabs({ [WORKTREE]: Array.from({ length: 50 }, (_, i) => `tab-${i}`) })
    for (let index = 0; index < 50; index += 1) {
      parkUntilHostMirrorHandleLands(ENV_A, WORKTREE, `tab-${index}`, () => {})
    }
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(50)
    expect(vi.getTimerCount()).toBe(50)

    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS + 1)

    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps every live pane verdict on the current connection', () => {
    setRuntimeEnvironmentConnectionGenerationForTests(ENV_A, 1)
    setLiveTabs({ [WORKTREE]: ['tab-a', 'tab-b', 'tab-c'] })
    parkAndExpire(ENV_A, WORKTREE, 'tab-a')
    parkAndExpire(ENV_A, WORKTREE, 'tab-b')
    parkAndExpire(ENV_A, WORKTREE, 'tab-c')

    // Every one of these rows is still published, so every verdict is still answerable.
    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'tab-a')).toBe(true)
    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'tab-b')).toBe(true)
    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'tab-c')).toBe(true)
    expect(countExpiredHostMirrorHandleGapVerdictsForTests()).toBe(3)
  })

  it('does not retain an expired verdict for a tab that closed on the same connection', () => {
    setRuntimeEnvironmentConnectionGenerationForTests(ENV_A, 1)
    // A long-lived connection: the generation never advances while tabs churn.
    for (let index = 0; index < 500; index += 1) {
      setLiveTabs({ [WORKTREE]: [`tab-${index}`] })
      parkAndExpire(ENV_A, WORKTREE, `tab-${index}`)
    }
    // Only the one pane still published may hold a verdict; the other 499 tab ids are
    // closed and will never be reissued.
    expect(countExpiredHostMirrorHandleGapVerdictsForTests()).toBe(1)
    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'tab-499')).toBe(true)
  })

  it('never drops another environment verdict for a row that is only mid-rehydration', () => {
    // Row absence is transient: during a rehydration a worktree's rows can be missing for a
    // frame before landing again on the SAME generation. A sweep triggered by an unrelated
    // environment must not read that frame as "the pane is gone" — the verdict would vanish and
    // the pane would re-park on a fresh full budget, which is the spurious-release-resets-the-
    // timer hazard in a new place.
    setRuntimeEnvironmentConnectionGenerationForTests(ENV_A, 1)
    setRuntimeEnvironmentConnectionGenerationForTests(ENV_B, 1)
    setLiveTabs({ 'repo-1::wt-b': ['tab-b'], 'repo-1::wt-a': ['tab-a'] })
    parkAndExpire(ENV_B, 'repo-1::wt-b', 'tab-b')
    expect(hasHostMirrorHandleWaitExpired(ENV_B, 'tab-b')).toBe(true)

    // B is briefly rowless while A's pane times out and records its own verdict.
    setLiveTabs({ 'repo-1::wt-a': ['tab-a'] })
    parkAndExpire(ENV_A, 'repo-1::wt-a', 'tab-a')

    setLiveTabs({ 'repo-1::wt-b': ['tab-b'], 'repo-1::wt-a': ['tab-a'] })
    expect(hasHostMirrorHandleWaitExpired(ENV_B, 'tab-b')).toBe(true)
  })

  it('drops an environment verdict once that environment reconnects', () => {
    setRuntimeEnvironmentConnectionGenerationForTests(ENV_A, 1)
    setLiveTabs({ [WORKTREE]: ['tab-a', 'tab-b'] })
    parkAndExpire(ENV_A, WORKTREE, 'tab-a')
    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'tab-a')).toBe(true)

    // Both rows survive the reconnect, so only the generation rule may drop tab-a.
    setRuntimeEnvironmentConnectionGenerationForTests(ENV_A, 2)
    expect(hasHostMirrorHandleWaitExpired(ENV_A, 'tab-a')).toBe(false)
    parkAndExpire(ENV_A, WORKTREE, 'tab-b')
    expect(countExpiredHostMirrorHandleGapVerdictsForTests()).toBe(1)
  })

  it('holds exactly one store subscription for exactly as long as a waiter exists', () => {
    let active = 0
    const realSubscribe = useAppStore.subscribe.bind(useAppStore)
    vi.spyOn(useAppStore, 'subscribe').mockImplementation(((listener: never) => {
      active += 1
      const unsubscribe = realSubscribe(listener)
      return () => {
        active -= 1
        unsubscribe()
      }
    }) as never)

    setRuntimeEnvironmentConnectionGenerationForTests(ENV_A, 1)
    setLiveTabs({ [WORKTREE]: ['tab-a', 'tab-b'] })
    expect(active).toBe(0)

    parkUntilHostMirrorHandleLands(ENV_A, WORKTREE, 'tab-a', () => {})
    parkUntilHostMirrorHandleLands(ENV_A, WORKTREE, 'tab-b', () => {})
    expect(active).toBe(1)

    // The handle lands for one pane. The other is still parked, so releasing the
    // subscription here would strand it: nothing would ever notice its handle.
    useAppStore.setState({ ptyIdsByTabId: { 'tab-a': ['pty-a'] } } as unknown as AppState)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
    expect(active).toBe(1)

    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS + 1)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
    expect(active).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    vi.restoreAllMocks()
  })

  it('returns both maps to baseline across a full connect/churn/disconnect loop', () => {
    for (let round = 0; round < 400; round += 1) {
      const environmentId = round % 2 === 0 ? ENV_A : ENV_B
      const worktreeId = `repo-1::worktree-${round}`
      setRuntimeEnvironmentConnectionGenerationForTests(environmentId, round + 1)
      setLiveTabs({ [worktreeId]: [`tab-${round}`] })
      parkAndExpire(environmentId, worktreeId, `tab-${round}`)
    }
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    // One per environment: each sweeps only its own rows, so each keeps the newest verdict it
    // recorded and nothing older. 400 rounds, 2 environments, 2 entries.
    expect(countExpiredHostMirrorHandleGapVerdictsForTests()).toBe(2)
  })
})
