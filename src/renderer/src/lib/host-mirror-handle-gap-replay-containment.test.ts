import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import {
  HOST_MIRROR_HANDLE_GAP_DEADLINE_MS,
  countParkedHostMirrorHandleGapPanesForTests,
  parkUntilHostMirrorHandleLands,
  resetHostMirrorHandleGapWaitsForTests
} from './host-mirror-handle-gap-wait'

// What this pins: the parked replay is `resumeSleepingAgentSessionsForWorktree`, a large
// synchronous sweep, and it is released from inside `useAppStore.subscribe`. Zustand notifies
// listeners in a plain loop, so a replay that throws escapes the `setState` that triggered it:
// the listeners registered after this module never see the write, and every sibling pane the
// same mirror frame made due is left parked. The waiter's own state is torn down before `run`,
// so containing the throw holds nothing back.

const initialAppStoreState = useAppStore.getState()
const ENV_ID = 'env-gap-containment'

function seedTwoMirroredPanes(): void {
  useAppStore.setState({
    tabsByWorktree: {
      wt: [
        { id: 'tab-a', title: 'a', ptyId: null },
        { id: 'tab-b', title: 'b', ptyId: null }
      ] as never
    },
    ptyIdsByTabId: {}
  })
}

describe('host-mirror handle-gap replay containment', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useAppStore.setState(initialAppStoreState, true)
  })

  afterEach(() => {
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    useAppStore.setState(initialAppStoreState, true)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('a replay that throws neither aborts the store write nor strands its sibling panes', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedTwoMirroredPanes()
    const siblingReplay = vi.fn()
    parkUntilHostMirrorHandleLands(ENV_ID, 'wt', 'tab-a', () => {
      throw new Error('replay blew up')
    })
    parkUntilHostMirrorHandleLands(ENV_ID, 'wt', 'tab-b', siblingReplay)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(2)

    // A store subscriber registered after this module's, so it is notified after the drain.
    const laterSubscriber = vi.fn()
    const unsubscribe = useAppStore.subscribe(laterSubscriber)

    // One mirror frame lands both handles, making both waiters due on a single store write.
    expect(() =>
      useAppStore.setState({ ptyIdsByTabId: { 'tab-a': ['pty-a'], 'tab-b': ['pty-b'] } })
    ).not.toThrow()
    unsubscribe()

    expect(siblingReplay).toHaveBeenCalledTimes(1)
    expect(laterSubscriber).toHaveBeenCalledTimes(1)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
  })

  it('a replay that throws on the deadline path does not escape the timer', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedTwoMirroredPanes()
    parkUntilHostMirrorHandleLands(ENV_ID, 'wt', 'tab-a', () => {
      throw new Error('replay blew up')
    })

    expect(() => vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)).not.toThrow()
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
  })
})
