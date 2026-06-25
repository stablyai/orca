// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree } from '../../../../shared/types'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makeOpenFile, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import { useGitStatusPolling } from './useGitStatusPolling'

// Mock the refresh boundary so we count invocations precisely without
// triggering real IPC cascades (upstream probes, store mutations, etc.).
const refreshMock = vi.hoisted(() => vi.fn())
vi.mock('./git-status-refresh', () => ({
  refreshGitStatusForWorktree: refreshMock
}))

const initialAppState = useAppStore.getInitialState()

const REPO_ID = 'repo1'
const WORKTREE_PATH = '/repo1'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`

const REPO_ID2 = 'repo2'
const WORKTREE_PATH2 = '/repo2'
const WORKTREE_ID2 = `${REPO_ID2}::${WORKTREE_PATH2}`

const repo: Repo = { ...TEST_REPO, kind: 'git', connectionId: null }
const worktree: Worktree = makeWorktree({ id: WORKTREE_ID, repoId: REPO_ID, path: WORKTREE_PATH })

const repo2: Repo = {
  ...TEST_REPO,
  id: REPO_ID2,
  path: WORKTREE_PATH2,
  kind: 'git',
  connectionId: null
}
const worktree2: Worktree = makeWorktree({
  id: WORKTREE_ID2,
  repoId: REPO_ID2,
  path: WORKTREE_PATH2
})

const roots: Root[] = []

function HookProbe(): null {
  useGitStatusPolling()
  return null
}

async function renderHook(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe))
  })
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useGitStatusPolling rerender stability', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    refreshMock.mockReset().mockResolvedValue(undefined)

    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      activeWorktreeId: WORKTREE_ID,
      worktreesByRepo: {
        [REPO_ID]: [worktree],
        [REPO_ID2]: [worktree2]
      },
      repos: [repo, repo2],
      rightSidebarOpen: true,
      rightSidebarTab: 'source-control',
      rightSidebarExplorerView: 'files',
      openFiles: [],
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings']
    } as Partial<AppState>)
  })

  afterEach(() => {
    // Unmount roots WHILE fake timers are still active so effect cleanups
    // call the faked clearInterval/clearTimeout on matching fake handles.
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
    vi.useRealTimers()
  })

  it('keeps the poll runner stable when openFiles changes mid-cooldown', async () => {
    // Spy on addEventListener so we can guard that the file-watch listener
    // registered before emitting — otherwise the test would prove nothing.
    const addSpy = vi.spyOn(window, 'addEventListener')

    await renderHook()
    await flushMicrotasks()

    // First poll fires immediately (installWindowVisibilityInterval calls
    // run() once at install time).
    expect(refreshMock).toHaveBeenCalledTimes(1)

    // Rerender: change openFiles in the store. This gives runFetchStatus a new
    // identity (it lists openFiles in its useCallback deps). With the old
    // useMemo([runFetchStatus]) the runner would be recreated here, resetting
    // lastRunEndedAt to -Infinity and bypassing the cooldown.
    await act(async () => {
      useAppStore.setState({
        openFiles: [makeOpenFile({ id: `${WORKTREE_PATH}/a.ts`, worktreeId: WORKTREE_ID })]
      })
    })
    await flushMicrotasks()

    // Guard: the file-watch listener must be registered, or the event below
    // is a no-op and the test cannot distinguish fix from bug.
    expect(addSpy).toHaveBeenCalledWith(ORCA_WORKTREE_FILE_CHANGE_EVENT, expect.any(Function))

    // Fire a file-watch event to drive fetchStatus during the cooldown.
    window.dispatchEvent(
      new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
        detail: {
          payload: {
            worktreePath: WORKTREE_PATH,
            events: [{ kind: 'update', absolutePath: `${WORKTREE_PATH}/a.ts` }]
          },
          runtimeEnvironmentId: null
        }
      })
    )

    // Advance past the 125 ms file-watch debounce. fetchStatus is called, but
    // the runner's cooldown (POLL_INTERVAL_MS = 3000 ms from first run end)
    // should suppress the second refresh.
    await vi.advanceTimersByTimeAsync(200)
    expect(refreshMock).toHaveBeenCalledTimes(1)

    // Mid-cooldown: still no second refresh.
    await vi.advanceTimersByTimeAsync(1300)
    expect(refreshMock).toHaveBeenCalledTimes(1)

    // After the full 3 s cooldown the trailing refresh fires.
    await vi.advanceTimersByTimeAsync(1500)
    await flushMicrotasks()
    expect(refreshMock).toHaveBeenCalledTimes(2)

    addSpy.mockRestore()
  })
  it('triggers an immediate poll when the active worktree changes (no delay)', async () => {
    await renderHook()
    await flushMicrotasks()

    // First poll on mount (worktree 1)
    expect(refreshMock).toHaveBeenCalledTimes(1)

    // Switch active worktree to worktree 2
    await act(async () => {
      useAppStore.setState({
        activeWorktreeId: WORKTREE_ID2
      })
    })
    await flushMicrotasks()

    // Should trigger an immediate poll on the new worktree (total 2 calls)
    // without having to wait for the 3000ms timer.
    expect(refreshMock).toHaveBeenCalledTimes(2)
  })
})
