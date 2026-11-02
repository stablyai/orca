import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
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
import { makeTerminalTab } from '../store/slices/worktrees-slice-test-fixtures'

/** A published handle ends this gap and permits a fresh wait on the next gap of the same pane/connection; generation, row death, teardown and pane identity cannot detect that transition. Never-landed handles still have bounded waits. */

const ENV_ID = 'env-landed-handle'
const WORKTREE = 'repo-1::wt-landed'
const TAB_ID = 'web-terminal-landed'
const PANE_PTY_ID = `remote:${encodeURIComponent(ENV_ID)}@@term_1`
const initialAppStoreState = useAppStore.getState()

/** Publishes the row AND the layout binding that makes the pane unverifiable rather than dead. */
function publishRow(options: { handleLanded: boolean }): void {
  useAppStore.setState({
    tabsByWorktree: {
      [WORKTREE]: [makeTerminalTab({ id: TAB_ID, worktreeId: WORKTREE, title: 't' })]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-1': PANE_PTY_ID }
      }
    },
    ptyIdsByTabId: options.handleLanded ? { [TAB_ID]: [PANE_PTY_ID] } : {}
  })
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

    // Only the handle changed; it ends the gap the verdict measured.
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
})
