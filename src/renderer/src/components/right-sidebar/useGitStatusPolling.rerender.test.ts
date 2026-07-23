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

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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

async function renderHook(): Promise<Root> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe))
  })
  return root
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

  it('keeps the refresh scheduler stable when openFiles changes mid-signal debounce', async () => {
    // Spy on addEventListener so we can guard that the file-watch listener
    // registered before emitting — otherwise the test would prove nothing.
    const addSpy = vi.spyOn(window, 'addEventListener')

    await renderHook()
    await flushMicrotasks()

    // First poll fires immediately (installWindowVisibilityInterval calls
    // run() once at install time).
    expect(refreshMock).toHaveBeenCalledTimes(1)

    // Rerender: change openFiles in the store while the file-watch/scheduler
    // debounce is pending. The active-worktree scheduler must survive it.
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

    // Advance past the 125 ms file-watch debounce. The scheduler coalesces the
    // signal and paces it behind the 3 s anti-churn floor from the mount run.
    await vi.advanceTimersByTimeAsync(200)
    expect(refreshMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2799)
    expect(refreshMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
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

  it('refreshes immediately when Source Control becomes visible', async () => {
    useAppStore.setState({ rightSidebarOpen: false })
    await renderHook()
    await flushMicrotasks()
    expect(refreshMock).toHaveBeenCalledTimes(1)

    // Let the 3 s anti-churn floor from the mount refresh elapse first.
    await vi.advanceTimersByTimeAsync(3000)
    await act(async () => {
      useAppStore.setState({ rightSidebarOpen: true })
    })
    await flushMicrotasks()

    expect(refreshMock).toHaveBeenCalledTimes(2)
  })

  it('refreshes immediately when the Files tab becomes visible', async () => {
    useAppStore.setState({ rightSidebarOpen: false, rightSidebarTab: 'explorer' })
    await renderHook()
    await flushMicrotasks()
    expect(refreshMock).toHaveBeenCalledTimes(1)

    // Let the 3 s anti-churn floor from the mount refresh elapse first.
    await vi.advanceTimersByTimeAsync(3000)
    await act(async () => {
      useAppStore.setState({ rightSidebarOpen: true })
    })
    await flushMicrotasks()

    expect(refreshMock).toHaveBeenCalledTimes(2)
  })

  it('refreshes immediately when an SSH execution host reconnects', async () => {
    useAppStore.setState({
      repos: [{ ...repo, connectionId: 'ssh-1' }],
      sshConnectionStates: new Map([
        ['ssh-1', { status: 'disconnected', error: null, reconnectAttempt: 0 }]
      ])
    } as Partial<AppState>)
    await renderHook()
    await flushMicrotasks()
    expect(refreshMock).not.toHaveBeenCalled()

    await act(async () => {
      useAppStore.setState({
        sshConnectionStates: new Map([
          ['ssh-1', { status: 'connected', error: null, reconnectAttempt: 0 }]
        ])
      } as Partial<AppState>)
    })
    await flushMicrotasks()

    expect(refreshMock).toHaveBeenCalledTimes(1)
  })

  it('marks only the 60-second safety refresh for line-stat reuse', async () => {
    await renderHook()
    await flushMicrotasks()

    expect(refreshMock.mock.calls[0]?.[0].request.reuseLineStats).toBeUndefined()
    await vi.advanceTimersByTimeAsync(60_000)
    await flushMicrotasks()

    expect(refreshMock).toHaveBeenCalledTimes(2)
    expect(refreshMock.mock.calls[1]?.[0].request.reuseLineStats).toBe(true)
  })

  it('aborts and rejects stale work when the execution host changes', async () => {
    let resolveFirst!: () => void
    const firstRefresh = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    let firstRequest!: { signal: AbortSignal; shouldApply: () => boolean }
    refreshMock.mockImplementationOnce(
      (args: { request: { signal: AbortSignal; shouldApply: () => boolean } }) => {
        firstRequest = args.request
        return firstRefresh
      }
    )
    await renderHook()
    expect(refreshMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      useAppStore.setState({
        worktreesByRepo: {
          [REPO_ID]: [{ ...worktree, hostId: 'runtime:env-2' }],
          [REPO_ID2]: [worktree2]
        }
      })
    })
    await flushMicrotasks()

    expect(firstRequest.signal.aborted).toBe(true)
    expect(firstRequest.shouldApply()).toBe(false)
    expect(refreshMock).toHaveBeenCalledTimes(2)
    resolveFirst()
    await flushMicrotasks()
  })

  it('aborts and rejects stale work on unmount', async () => {
    let resolveFirst!: () => void
    const firstRefresh = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    let firstRequest!: { signal: AbortSignal; shouldApply: () => boolean }
    refreshMock.mockImplementationOnce(
      (args: { request: { signal: AbortSignal; shouldApply: () => boolean } }) => {
        firstRequest = args.request
        return firstRefresh
      }
    )
    const root = await renderHook()

    act(() => root.unmount())
    roots.splice(roots.indexOf(root), 1)

    expect(firstRequest.signal.aborted).toBe(true)
    expect(firstRequest.shouldApply()).toBe(false)
    resolveFirst()
    await flushMicrotasks()
  })
})
