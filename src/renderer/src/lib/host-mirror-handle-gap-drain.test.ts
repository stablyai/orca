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

// What this file pins, and why it is separate from host-mirror-handle-gap-resume.test.ts: that file
// drives the waiter through the real resume sweep, so it cannot choose what a replay DOES. These
// tests park with a `run` of their own to exercise the drain itself — the loop that releases every
// due pane from one store write, running synchronously inside a zustand subscriber. The panes in
// that loop are strangers to each other and the store write that triggered it is a stranger to all
// of them, so one pane's replay must not be able to reach either.

const ENVIRONMENT_ID = 'env-handle-gap-drain'
const WORKTREE_ID = 'repo-1::/workspace/repo'
const FIRST_TAB_ID = 'web-terminal-host-tab-1'
const SECOND_TAB_ID = 'web-terminal-host-tab-2'

const initialAppStoreState = useAppStore.getState()

function seedRows(): void {
  // Layout bindings are seeded because a verdict names the PANE by the environment-minted PTY it
  // held at park time. A pane with no binding never reaches the park path in production, and its
  // verdict deliberately refuses to answer, so a fixture without one models nothing real.
  useAppStore.setState({
    ptyIdsByTabId: {},
    tabsByWorktree: {
      [WORKTREE_ID]: [
        { id: FIRST_TAB_ID, title: 'one' },
        { id: SECOND_TAB_ID, title: 'two' }
      ]
    },
    terminalLayoutsByTabId: {
      [FIRST_TAB_ID]: {
        root: { type: 'leaf', leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-1': `remote:${ENVIRONMENT_ID}@@term_1` }
      },
      [SECOND_TAB_ID]: {
        root: { type: 'leaf', leafId: 'leaf-2' },
        activeLeafId: 'leaf-2',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-2': `remote:${ENVIRONMENT_ID}@@term_2` }
      }
    }
  } as never)
}

/** The host publishes both panes' PTY handles on one frame: both waiters come due together. */
function publishBothHandles(): void {
  useAppStore.setState({
    ptyIdsByTabId: { [FIRST_TAB_ID]: ['pty-1'], [SECOND_TAB_ID]: ['pty-2'] }
  } as never)
}

describe('host-mirror handle-gap drain', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    seedRows()
  })

  afterEach(() => {
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    useAppStore.setState(initialAppStoreState, true)
    vi.useRealTimers()
  })

  // The drain runs inside `useAppStore.subscribe`, so an unguarded throw from one pane's replay
  // leaves the store write that published the handle throwing at its own call site — the mirror
  // apply path, which has nothing to do with this pane. `resumeSleepingAgentSessionsForWorktree`
  // reaches `state.createTab` with no guard of its own, so the throw is reachable.
  it('does not let one pane’s replay throw out of the store write that released it', () => {
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, FIRST_TAB_ID, () => {
      throw new Error('replay blew up')
    })
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, SECOND_TAB_ID, () => {})

    expect(() => publishBothHandles()).not.toThrow()
  })

  // Same write, the other victim: the panes in a drain are strangers. A replay that throws must not
  // strand every pane queued behind it — a stranded pane holds its park until its own deadline and
  // then decides on a connection whose evidence has long since landed.
  it('releases every other due pane when one pane’s replay throws', () => {
    const secondReplay = vi.fn()
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, FIRST_TAB_ID, () => {
      throw new Error('replay blew up')
    })
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, SECOND_TAB_ID, secondReplay)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(2)

    try {
      publishBothHandles()
    } catch {
      // The assertion is about the second pane, not about who swallowed the throw.
    }

    expect(secondReplay).toHaveBeenCalledTimes(1)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
    // Both deadlines are cancelled, so neither pane can record an expiry it did not earn.
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS * 2)
    expect(hasHostMirrorHandleWaitExpired(ENVIRONMENT_ID, FIRST_TAB_ID)).toBe(false)
    expect(hasHostMirrorHandleWaitExpired(ENVIRONMENT_ID, SECOND_TAB_ID)).toBe(false)
  })

  // The deadline path fans out the same way: one expiring pane's replay must not keep another pane
  // from recording its own verdict on the same connection.
  it('records the expiry of a pane whose replay throws and still frees the pane', () => {
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, FIRST_TAB_ID, () => {
      throw new Error('replay blew up')
    })

    expect(() => vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)).not.toThrow()

    expect(hasHostMirrorHandleWaitExpired(ENVIRONMENT_ID, FIRST_TAB_ID)).toBe(true)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
