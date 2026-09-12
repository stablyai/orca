import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  setRuntimeEnvironmentConnectionGenerationForTests
} from '@/store/slices/runtime-status'
import {
  HOST_MIRROR_HANDLE_GAP_DEADLINE_MS,
  countParkedHostMirrorHandleGapPanesForTests,
  hasHostMirrorHandleWaitExpired,
  parkUntilHostMirrorHandleLands,
  resetHostMirrorHandleGapWaitsForTests
} from './host-mirror-handle-gap-wait'

/**
 * The fourth eviction trigger: a PUBLISHED HANDLE ends the gap episode its verdict measured.
 *
 * Why none of the other three reach it. The generation rule cannot: the #19647 change in this same
 * stack stops recording `status: null` for an unreachable host, so `connectionChanged` no longer
 * fires across an outage on one runtime. The tab-death rule cannot: the row stays published the
 * whole time — it is the HANDLE that comes and goes, which is the definition of the gap. Teardown
 * cannot: the environment is still here. And the read-time pane-identity check cannot, because the
 * pane that reattaches to the SAME PTY is deliberately the same pane
 * (`host-mirror-handle-gap-verdict-union.test.ts`, "answers for a genuine reattach").
 *
 * So a verdict outlives the gap it was about, and the NEXT gap on that pane gets no wait at all —
 * #19735 with the bounded wait removed rather than merely shortened.
 *
 * Why this does not reopen the park/expire/replay loop the verdict exists to break: that loop is
 * a handle that NEVER lands. A landed handle between two gaps is positive host evidence, and each
 * wait is still individually bounded by the deadline.
 */

const ENV_ID = 'env-landed-handle'
const WORKTREE = 'repo-1::wt-landed'
const TAB_ID = 'web-terminal-landed'
const PANE_PTY_ID = `remote:${encodeURIComponent(ENV_ID)}@@term_1`
const initialAppStoreState = useAppStore.getState()

/** Publishes the row AND the layout binding that makes the pane unverifiable rather than dead. */
function publishRow(options: { handleLanded: boolean }): void {
  useAppStore.setState({
    tabsByWorktree: { [WORKTREE]: [{ id: TAB_ID, title: 't', ptyId: null }] },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-1': PANE_PTY_ID }
      }
    },
    ptyIdsByTabId: options.handleLanded ? { [TAB_ID]: [PANE_PTY_ID] } : {}
  } as unknown as AppState)
}

describe('handle-gap verdict, landed-handle eviction', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useAppStore.setState(initialAppStoreState, true)
    setRuntimeEnvironmentConnectionGenerationForTests(ENV_ID, 1)
  })

  afterEach(() => {
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    useAppStore.setState(initialAppStoreState, true)
    vi.useRealTimers()
  })

  it('retires the verdict when the pane it was about finally publishes its handle', () => {
    publishRow({ handleLanded: false })
    parkUntilHostMirrorHandleLands(ENV_ID, WORKTREE, TAB_ID, vi.fn())
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS + 1)
    expect(hasHostMirrorHandleWaitExpired(ENV_ID, TAB_ID)).toBe(true)

    // Same connection, same pane, same layout binding — only the handle is new. The verdict's
    // subject has answered, so the verdict is spent.
    publishRow({ handleLanded: true })
    expect(hasHostMirrorHandleWaitExpired(ENV_ID, TAB_ID)).toBe(false)
  })

  it('gives the next gap on that pane its own full wait', () => {
    publishRow({ handleLanded: false })
    parkUntilHostMirrorHandleLands(ENV_ID, WORKTREE, TAB_ID, vi.fn())
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS + 1)
    publishRow({ handleLanded: true })

    // A later frame republishes the row ahead of its handle: a NEW gap on the same connection.
    publishRow({ handleLanded: false })
    expect(hasHostMirrorHandleWaitExpired(ENV_ID, TAB_ID)).toBe(false)

    const replay = vi.fn()
    parkUntilHostMirrorHandleLands(ENV_ID, WORKTREE, TAB_ID, replay)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
    expect(replay).not.toHaveBeenCalled()
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS + 1)
    expect(replay).toHaveBeenCalledTimes(1)
  })

  it('a wait re-parked under a new worktree is released by that worktree, not the old one', () => {
    // Adopting an orphaned terminal re-keys `tabsByWorktree` without re-keying the record, so the
    // re-park hands the live wait a new worktree. Retraction evidence about the OLD one says
    // nothing about the wait that is actually running.
    useAppStore.setState({
      tabsByWorktree: {
        'wt-old': [{ id: TAB_ID, title: 't', ptyId: null }],
        'wt-new': [{ id: TAB_ID, title: 't', ptyId: null }]
      },
      ptyIdsByTabId: {}
    } as unknown as AppState)
    parkUntilHostMirrorHandleLands(ENV_ID, 'wt-old', TAB_ID, vi.fn())
    const replayAfterAdoption = vi.fn()
    parkUntilHostMirrorHandleLands(ENV_ID, 'wt-new', TAB_ID, replayAfterAdoption)

    useAppStore.setState({
      tabsByWorktree: { 'wt-new': [{ id: TAB_ID, title: 't', ptyId: null }] }
    } as unknown as AppState)
    expect(replayAfterAdoption).not.toHaveBeenCalled()
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)

    useAppStore.setState({ tabsByWorktree: {} } as unknown as AppState)
    expect(replayAfterAdoption).toHaveBeenCalledTimes(1)
  })
})
