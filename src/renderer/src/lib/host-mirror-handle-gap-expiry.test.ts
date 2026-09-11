import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import {
  HOST_MIRROR_HANDLE_GAP_DEADLINE_MS,
  countParkedHostMirrorHandleGapPanesForTests,
  hasHostMirrorHandleWaitExpired,
  parkUntilHostMirrorHandleLands,
  resetHostMirrorHandleGapWaitsForTests
} from './host-mirror-handle-gap-wait'

// What this pins: the expiry verdict is per handle-gap EPISODE, not per connection generation.
// The module's stated escape was "a reconnect bumps the connection generation and arms a fresh
// wait", but #19647 (same stack) stops recording `status: null` for an unreachable host, so
// `connectionChanged` no longer fires across an outage on the same runtime. A verdict that
// outlives the gap it was about removes the bounded wait entirely for every later gap on that
// pane — the #19735 fork with no wait at all, which is worse than the shortened wait the
// deadline was designed to give.

const initialAppStoreState = useAppStore.getState()
const ENV_ID = 'env-gap-expiry'
const TAB_ID = 'web-terminal-expiry-tab'

function publishRowWithoutHandle(worktreeId = 'wt'): void {
  useAppStore.setState({
    tabsByWorktree: { [worktreeId]: [{ id: TAB_ID, title: 't', ptyId: null }] as never },
    ptyIdsByTabId: {}
  })
}

describe('host-mirror handle-gap expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useAppStore.setState(initialAppStoreState, true)
  })

  afterEach(() => {
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    useAppStore.setState(initialAppStoreState, true)
    vi.useRealTimers()
  })

  it('a landed handle retires the expiry so the next gap gets its own wait', () => {
    publishRowWithoutHandle()
    parkUntilHostMirrorHandleLands(ENV_ID, 'wt', TAB_ID, vi.fn())

    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)
    expect(hasHostMirrorHandleWaitExpired(ENV_ID, TAB_ID)).toBe(true)

    // The handle the wait was about finally lands — positive host evidence, same connection.
    useAppStore.setState({ ptyIdsByTabId: { [TAB_ID]: ['remote:env@@term_1'] } })
    expect(hasHostMirrorHandleWaitExpired(ENV_ID, TAB_ID)).toBe(false)

    // A later frame republishes the row ahead of its handle: a NEW gap, which must be waited on.
    publishRowWithoutHandle()
    expect(hasHostMirrorHandleWaitExpired(ENV_ID, TAB_ID)).toBe(false)
    const secondRun = vi.fn()
    parkUntilHostMirrorHandleLands(ENV_ID, 'wt', TAB_ID, secondRun)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
    expect(secondRun).not.toHaveBeenCalled()
  })

  it('a wait re-parked under a new worktree is released by that worktree, not the old one', () => {
    useAppStore.setState({
      tabsByWorktree: {
        'wt-old': [{ id: TAB_ID, title: 't', ptyId: null }] as never,
        'wt-new': [{ id: TAB_ID, title: 't', ptyId: null }] as never
      },
      ptyIdsByTabId: {}
    })
    parkUntilHostMirrorHandleLands(ENV_ID, 'wt-old', TAB_ID, vi.fn())
    const replayAfterAdoption = vi.fn()
    parkUntilHostMirrorHandleLands(ENV_ID, 'wt-new', TAB_ID, replayAfterAdoption)

    // Only the OLD worktree's rows are retracted. That says nothing about the live wait.
    useAppStore.setState({
      tabsByWorktree: { 'wt-new': [{ id: TAB_ID, title: 't', ptyId: null }] as never }
    })
    expect(replayAfterAdoption).not.toHaveBeenCalled()
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)

    // Retracting the worktree the wait is actually about does release it.
    useAppStore.setState({ tabsByWorktree: {} })
    expect(replayAfterAdoption).toHaveBeenCalledTimes(1)
  })
})
