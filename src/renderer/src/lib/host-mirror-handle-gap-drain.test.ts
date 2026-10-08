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
//
// Both release paths are here on purpose: the store-write drain and the deadline both funnel into
// `releaseWaiter`, and a guard added to one is easy to forget on the other. One mutation —
// rethrowing from that catch — kills the first and last cases together, which is the point: they
// are the two entry points, not two behaviours. The two middle cases are about what one replay can
// do to the pane queued behind it while the drain is mid-loop, and neither involves a throw.

const ENVIRONMENT_ID = 'env-handle-gap-drain'
const WORKTREE_ID = 'repo-1::/workspace/repo'
const FIRST_TAB_ID = 'web-terminal-host-tab-1'
const SECOND_TAB_ID = 'web-terminal-host-tab-2'

const initialAppStoreState = useAppStore.getState()

function seedRows(): void {
  // Layout bindings are seeded because a verdict names the PANE by the environment-minted PTY it
  // held at park time. A pane with no binding never reaches the park path in production, and its
  // verdict deliberately refuses to answer, so a fixture without one models nothing real.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seeded slice names only the store fields this suite drives; the rest of AppState keeps its defaults.
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seeded slice names only the store fields this suite drives; the rest of AppState keeps its defaults.
  useAppStore.setState({
    ptyIdsByTabId: {
      [FIRST_TAB_ID]: [`remote:${ENVIRONMENT_ID}@@term_1`],
      [SECOND_TAB_ID]: [`remote:${ENVIRONMENT_ID}@@term_2`]
    }
  } as never)
}

describe('host-mirror handle-gap drain', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // The replays below throw on purpose; the module logs and swallows, which is the behaviour
    // under test, so the log itself is noise.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    seedRows()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    useAppStore.setState(initialAppStoreState, true)
    vi.useRealTimers()
  })

  // The drain runs inside `useAppStore.subscribe`, and zustand notifies listeners in a plain loop
  // with no queue, so an unguarded throw from one pane's replay reaches three strangers at once:
  // the `setState` that published the handle (the mirror apply, which has nothing to do with this
  // pane), every sibling pane the same frame made due, and every listener registered after this
  // module's. `resumeSleepingAgentSessionsForWorktree` reaches `state.createTab` with no guard of
  // its own, so the throw is reachable.
  it('does not let one pane’s replay throw reach the store write, its siblings, or later listeners', () => {
    const siblingReplay = vi.fn()
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, FIRST_TAB_ID, () => {
      throw new Error('replay blew up')
    })
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, SECOND_TAB_ID, siblingReplay)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(2)

    // Registered after this module's subscription, so it is notified after the drain.
    const laterListener = vi.fn()
    const unsubscribe = useAppStore.subscribe(laterListener)

    expect(() => publishBothHandles()).not.toThrow()
    unsubscribe()

    expect(siblingReplay).toHaveBeenCalledTimes(1)
    expect(laterListener).toHaveBeenCalledTimes(1)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
    // Both deadlines are cancelled, so neither pane can record an expiry it did not earn.
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS * 2)
    expect(hasHostMirrorHandleWaitExpired(ENVIRONMENT_ID, FIRST_TAB_ID)).toBe(false)
    expect(hasHostMirrorHandleWaitExpired(ENVIRONMENT_ID, SECOND_TAB_ID)).toBe(false)
  })

  // The drain is re-entrant: `resumeSleepingAgentSessionsForWorktree` reaches `createTab`, zustand
  // notifies with no queue, and the nested pass drains the same map the outer loop is still
  // walking. One store write must still mean one replay per pane. (Not one deadline per pane: the
  // re-park after a release always takes a fresh budget, whichever way this goes — what a second
  // release actually costs is running a whole worktree resume sweep again off one frame.)
  it('replays a pane once per store write even when an earlier replay re-enters the drain', () => {
    const siblingReplay = vi.fn(() => {
      // What the real replay does when the sweep still finds the pane undecided.
      parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, SECOND_TAB_ID, siblingReplay)
    })
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, FIRST_TAB_ID, () => {
      // Only `tabsByWorktree` and `ptyIdsByTabId` re-enter: the subscription's slice guard drops
      // everything else, so a `clearSleepingAgentSession` write would never reach the drain.
      useAppStore.setState({ tabsByWorktree: { ...useAppStore.getState().tabsByWorktree } })
    })
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, SECOND_TAB_ID, siblingReplay)

    publishBothHandles()

    expect(siblingReplay).toHaveBeenCalledTimes(1)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
  })

  // The other way the snapshot goes stale, and the one object identity cannot see: re-parking a
  // STILL-PARKED pane mutates the waiter in place, so its `worktreeId` can move between the moment
  // the drain judged it retracted and the moment it releases.
  //
  // Staged the only way production can reach it. A replay is
  // `resumeSleepingAgentSessionsForWorktree` closed over ONE worktree and re-parks only under that
  // worktree, so a waiter's worktree can only move when a DIFFERENT waiter's replay sweeps the
  // workspace the row was adopted into. Here the second tab has already been re-keyed onto the
  // canonical id — `canonicalizeTerminalSessionWorktreeId` re-keys `tabsByWorktree` and leaves the
  // sleeping record naming the old one — so the first pane's sweep legitimately owns it, while the
  // live waiter is still filed under the id its record named.
  it('does not release on retraction evidence a mid-drain adoption has already made stale', () => {
    const adoptedReplay = vi.fn()
    const ADOPTING_WORKTREE_ID = 'repo-1::/workspace/adopted'
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seeded slice names only the store fields this suite drives; the rest of AppState keeps its defaults.
    useAppStore.setState({
      tabsByWorktree: {
        [ADOPTING_WORKTREE_ID]: [
          { id: FIRST_TAB_ID, title: 'one' },
          { id: SECOND_TAB_ID, title: 'two' }
        ]
      }
    } as never)
    // Parked first so the drain reaches it first: `Map` preserves insertion order, and this pane's
    // replay is what makes the next entry's snapshot verdict stale. If that order ever inverted the
    // test would fail rather than pass quietly — the second pane would release before the adoption.
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, ADOPTING_WORKTREE_ID, FIRST_TAB_ID, () => {
      // The sweep for the adopting workspace, re-parking the pane it now owns. No store write: a
      // sweep that parks every record it finds launches nothing, which is exactly this case.
      parkUntilHostMirrorHandleLands(
        ENVIRONMENT_ID,
        ADOPTING_WORKTREE_ID,
        SECOND_TAB_ID,
        adoptedReplay
      )
    })
    parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, SECOND_TAB_ID, adoptedReplay)

    // The frame that starts the drain. The second tab is absent from the worktree its waiter is
    // filed under, so the snapshot reads retraction — evidence the adoption above makes obsolete
    // before the release loop reaches it.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seeded slice names only the store fields this suite drives; the rest of AppState keeps its defaults.
    useAppStore.setState({
      ptyIdsByTabId: { [FIRST_TAB_ID]: [`remote:${ENVIRONMENT_ID}@@term_1`] }
    } as never)

    expect(adoptedReplay).not.toHaveBeenCalled()
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
  })

  // The other entry into `releaseWaiter`. Here the throw would escape the timer callback instead of
  // the store write, and the verdict must still be recorded — a pane whose replay failed has still
  // used up its budget, and dropping the verdict re-parks it on a fresh one forever.
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
