// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makeOpenFile } from '../../store/slices/store-session-test-harness'
import { makeWorktree, TEST_REPO } from '../../store/slices/worktrees-slice-test-fixtures'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import { useGitStatusPolling } from './useGitStatusPolling'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// Mock refresh to count scheduler invocations without IPC cascades.
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
    // Unmount before restoring real timers so cleanup clears matching fake handles.
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
    vi.useRealTimers()
  })

  it('keeps the refresh scheduler stable when openFiles changes mid-signal debounce', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener')

    await renderHook()
    await flushMicrotasks()

    expect(refreshMock).toHaveBeenCalledTimes(1)

    // Change openFiles while scheduler debounce is pending; the scheduler must survive.
    await act(async () => {
      useAppStore.setState({
        openFiles: [makeOpenFile({ id: `${WORKTREE_PATH}/a.ts`, worktreeId: WORKTREE_ID })]
      })
    })
    await flushMicrotasks()

    // Assert subscription first so an unhandled event cannot make this test vacuous.
    expect(addSpy).toHaveBeenCalledWith(ORCA_WORKTREE_FILE_CHANGE_EVENT, expect.any(Function))

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

    // The 125ms signal debounce remains paced behind the mount run’s 3s floor.
    await vi.advanceTimersByTimeAsync(200)
    expect(refreshMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2799)
    expect(refreshMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(refreshMock).toHaveBeenCalledTimes(2)

    addSpy.mockRestore()
  })
  it('still refreshes while file-watch events never stop', async () => {
    await renderHook()
    await flushMicrotasks()
    expect(refreshMock).toHaveBeenCalledTimes(1)

    // Why: a nudge pushed back on every event would never fire under continuous agent writes.
    for (let elapsed = 0; elapsed < 4_000; elapsed += 50) {
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
      await vi.advanceTimersByTimeAsync(50)
    }
    await flushMicrotasks()
    expect(refreshMock.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('triggers an immediate poll when the active worktree changes (no delay)', async () => {
    await renderHook()
    await flushMicrotasks()

    expect(refreshMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      useAppStore.setState({
        activeWorktreeId: WORKTREE_ID2
      })
    })
    await flushMicrotasks()

    expect(refreshMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      useAppStore.setState({ activeWorktreeId: WORKTREE_ID })
    })
    await flushMicrotasks()

    expect(refreshMock).toHaveBeenCalledTimes(3)
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
        ['ssh-1', { targetId: 'ssh-1', status: 'disconnected', error: null, reconnectAttempt: 0 }]
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

  it('keeps the activity floor when the execution host flaps for the same worktree', async () => {
    await renderHook()
    await flushMicrotasks()
    expect(refreshMock).toHaveBeenCalledTimes(1)

    // Host flapping rebuilds the scheduler; retain pacing or sustained signals can run Git at the bare debounce floor.
    await act(async () => {
      useAppStore.setState({
        worktreesByRepo: {
          [REPO_ID]: [{ ...worktree, hostId: 'runtime:env-2' }],
          [REPO_ID2]: [worktree2]
        }
      })
    })
    await flushMicrotasks()
    await act(async () => {
      useAppStore.setState({
        worktreesByRepo: {
          [REPO_ID]: [worktree],
          [REPO_ID2]: [worktree2]
        }
      })
    })
    await flushMicrotasks()
    expect(refreshMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2999)
    expect(refreshMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(refreshMock).toHaveBeenCalledTimes(2)
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
