// @vitest-environment happy-dom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const refreshGitStatusForWorktree = vi.fn()
const setGitStatus = vi.fn()
const updateWorktreeGitIdentity = vi.fn()
const setUpstreamStatus = vi.fn()
const fetchUpstreamStatus = vi.fn()

type StoreShape = {
  agentStatusEpoch: number
  repos: Repo[]
  worktreesByRepo: Record<string, Worktree[]>
  settings: unknown
  setGitStatus: unknown
  updateWorktreeGitIdentity: unknown
  setUpstreamStatus: unknown
  fetchUpstreamStatus: unknown
}

let storeState: StoreShape
let root: Root | null = null
let container: HTMLDivElement | null = null
let fsListeners: ((payload: { worktreePath: string; events: unknown[] }) => void)[] = []

function emitFsChanged(worktreePath = '/repos/git-1'): void {
  for (const listener of fsListeners) {
    listener({ worktreePath, events: [] })
  }
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(storeState)
}))

vi.mock('../right-sidebar/git-status-refresh', () => ({
  refreshGitStatusForWorktree: (args: unknown) => refreshGitStatusForWorktree(args)
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: (worktreeId: string) => (worktreeId.startsWith('ssh-') ? 'ssh-1' : null)
}))

// Why derived from the store by default: every existing case then keeps its
// meaning, and only the tests that care about visibility set an override.
let visibleIdsOverride: string[] | null = null
let visibleIdsThrow: Error | null = null

vi.mock('./visible-worktrees', () => ({
  getVisibleWorktreeIds: () => {
    if (visibleIdsThrow) {
      throw visibleIdsThrow
    }
    return (
      visibleIdsOverride ??
      Object.values(storeState.worktreesByRepo).flatMap((list) => (list ?? []).map((wt) => wt.id))
    )
  }
}))

const { useSidebarChangeCountSync } = await import('./use-sidebar-change-count-sync')

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#999999',
    addedAt: 1,
    ...overrides
  } as Repo
}

function makeWorktree(repoId: string, path: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: `${repoId}::${path}`,
    repoId,
    path,
    displayName: path,
    branch: 'main',
    head: 'abc123',
    isBare: false,
    isMainWorktree: true,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  } as Worktree
}

function Probe({ enabled }: { enabled: boolean }): null {
  useSidebarChangeCountSync({ enabled })
  return null
}

async function mount(enabled = true): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<Probe enabled={enabled} />)
  })
}

async function rerender(enabled: boolean): Promise<void> {
  await act(async () => {
    root?.render(<Probe enabled={enabled} />)
  })
}

function polledPaths(): string[] {
  return refreshGitStatusForWorktree.mock.calls
    .map((call) => (call[0] as { worktreePath: string }).worktreePath)
    .sort()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  refreshGitStatusForWorktree.mockResolvedValue(undefined)
  storeState = {
    agentStatusEpoch: 0,
    repos: [makeRepo('git-1'), makeRepo('git-2')],
    worktreesByRepo: {
      'git-1': [makeWorktree('git-1', '/repos/git-1')],
      'git-2': [makeWorktree('git-2', '/repos/git-2')]
    },
    settings: { theme: 'dark' },
    setGitStatus,
    updateWorktreeGitIdentity,
    setUpstreamStatus,
    fetchUpstreamStatus
  }
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  fsListeners = []
  visibleIdsOverride = null
  visibleIdsThrow = null
  ;(window as unknown as { api: unknown }).api = {
    fs: {
      onFsChanged: (callback: (payload: { worktreePath: string; events: unknown[] }) => void) => {
        fsListeners.push(callback)
        return () => {
          fsListeners = fsListeners.filter((entry) => entry !== callback)
        }
      }
    }
  }
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  root = null
  container = null
  fsListeners = []
  delete (window as unknown as { api?: unknown }).api
  vi.useRealTimers()
})

describe('useSidebarChangeCountSync', () => {
  it('sweeps every Git workspace on mount', async () => {
    await mount()

    expect(polledPaths()).toEqual(['/repos/git-1', '/repos/git-2'])
  })

  it('does not skip the active workspace', async () => {
    // Why: Source Control only polls the active workspace while the right sidebar
    // shows its tab, so skipping it here blanks the selected row's count.
    ;(storeState as StoreShape & { activeWorktreeId?: string }).activeWorktreeId =
      'git-1::/repos/git-1'

    await mount()

    expect(polledPaths()).toContain('/repos/git-1')
  })

  it('skips folder workspaces, which have no Git status', async () => {
    storeState.repos = [
      makeRepo('git-1'),
      makeRepo('folder-1', { kind: 'folder' } as Partial<Repo>)
    ]
    storeState.worktreesByRepo = {
      'git-1': [makeWorktree('git-1', '/repos/git-1')],
      'folder-1': [makeWorktree('folder-1', '/repos/folder-1')]
    }

    await mount()

    expect(polledPaths()).toEqual(['/repos/git-1'])
  })

  it('does nothing while disabled', async () => {
    await mount(false)

    expect(refreshGitStatusForWorktree).not.toHaveBeenCalled()
  })

  it('contains a throw instead of rejecting into nobody', async () => {
    // Why on `process` and not `window`: the sweep is fired as `void sweep()`
    // from the interval, filesystem events and agent transitions, so a throw
    // rejects a promise no one holds and lands on the Node worker, not in the
    // happy-dom window. That is how it showed up -- as two unhandled errors in
    // Sidebar.test.tsx, whose partial store mock has no getState.
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    visibleIdsThrow = new Error('store shape surprised the sweep')

    try {
      await mount()
      await act(async () => {
        await Promise.resolve()
      })
      // Why an explicit turn of the microtask queue: Node reports an unhandled
      // rejection only once nothing has attached a handler by the end of the
      // tick, so asserting earlier would pass whether or not the catch exists.
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', onRejection)
    }

    expect(rejections).toEqual([])
    expect(refreshGitStatusForWorktree).not.toHaveBeenCalled()
  })

  it('sweeps again after a throw rather than staying wedged', async () => {
    // Why: the in-flight flag is cleared in a `finally`, so it survives the
    // throw path. Moving that reset into the try -- or catching before it --
    // would leave sweepInFlight true forever and silently drop every later
    // event, which no other case here would notice.
    visibleIdsThrow = new Error('transient')
    await mount()
    expect(refreshGitStatusForWorktree).not.toHaveBeenCalled()

    visibleIdsThrow = null
    await act(async () => {
      emitFsChanged()
      await vi.advanceTimersByTimeAsync(400)
    })

    expect(polledPaths()).toEqual(['/repos/git-1', '/repos/git-2'])
  })

  it('never routes a local workspace to the focused runtime', async () => {
    // Why the real helper and no mock: routing by the repo's *routed* owner falls
    // back to whatever runtime is focused, which dispatches a local workspace's
    // status to a host that does not know it (#6957). A background read wants the
    // explicit owner or local, nothing else.
    storeState.settings = { activeRuntimeEnvironmentId: 'env-focused' }

    await mount()

    const routed = refreshGitStatusForWorktree.mock.calls.map(
      (call) => call[0].settings.activeRuntimeEnvironmentId
    )
    expect(routed).toEqual([null, null])
  })

  it('routes a workspace whose repo declares a runtime host to that runtime', async () => {
    storeState.settings = { activeRuntimeEnvironmentId: 'env-focused' }
    storeState.repos = [makeRepo('git-1', { executionHostId: 'runtime:env-owner' })]
    storeState.worktreesByRepo = { 'git-1': [makeWorktree('git-1', '/repos/git-1')] }

    await mount()

    expect(refreshGitStatusForWorktree.mock.calls[0][0].settings).toEqual({
      activeRuntimeEnvironmentId: 'env-owner'
    })
  })

  it('passes the SSH connection id when the workspace has one', async () => {
    storeState.repos = [makeRepo('ssh-repo')]
    storeState.worktreesByRepo = { 'ssh-repo': [makeWorktree('ssh-repo', '/srv/app')] }

    await mount()

    // getConnectionId is mocked to answer for ssh-prefixed worktree ids.
    expect(refreshGitStatusForWorktree.mock.calls[0][0]).toMatchObject({ connectionId: 'ssh-1' })
  })

  it('polls again on the interval', async () => {
    await mount()
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })

    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(4)
  })

  it('skips the sweep while the window is hidden', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })

    await mount()

    expect(refreshGitStatusForWorktree).not.toHaveBeenCalled()
  })

  it('sweeps immediately when the window becomes visible again', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await mount()
    expect(refreshGitStatusForWorktree).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(polledPaths()).toEqual(['/repos/git-1', '/repos/git-2'])
  })

  it('caps how many workspaces it queries at once', async () => {
    const repoIds = Array.from({ length: 12 }, (_, index) => `git-${index}`)
    storeState.repos = repoIds.map((id) => makeRepo(id))
    storeState.worktreesByRepo = Object.fromEntries(
      repoIds.map((id) => [id, [makeWorktree(id, `/repos/${id}`)]])
    )
    let inFlight = 0
    let peak = 0
    const releases: (() => void)[] = []
    refreshGitStatusForWorktree.mockImplementation(() => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      return new Promise<void>((resolve) => {
        releases.push(() => {
          inFlight -= 1
          resolve()
        })
      })
    })

    await mount()

    expect(peak).toBe(4)
    await act(async () => {
      while (releases.length > 0) {
        releases.shift()?.()
        await Promise.resolve()
      }
    })
  })

  it('does not stack a second sweep on top of a slow one', async () => {
    // Why: a sweep slower than the interval would otherwise double every
    // workspace's Git load on each tick.
    const releases: (() => void)[] = []
    refreshGitStatusForWorktree.mockImplementation(
      () => new Promise<void>((resolve) => releases.push(resolve))
    )

    await mount()
    // Both workspaces belong to the first sweep, which never settles below.
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000)
    })

    // Three interval ticks passed and none of them started a second sweep.
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)
    await act(async () => {
      releases.forEach((resolve) => resolve())
    })
  })

  it('aborts in-flight requests when it unmounts', async () => {
    await mount()
    const signal = (
      refreshGitStatusForWorktree.mock.calls[0][0] as {
        request: { signal: AbortSignal }
      }
    ).request.signal
    expect(signal.aborted).toBe(false)

    await act(async () => {
      root?.unmount()
    })
    root = null

    expect(signal.aborted).toBe(true)
  })

  it('keeps sweeping across re-renders that only change store action identity', async () => {
    // Why: the effect used to depend on the store setters; a new identity restarted
    // it, and the abort dropped whichever workspaces the sweep had not reached.
    await mount()
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)
    const firstSignal = (
      refreshGitStatusForWorktree.mock.calls[0][0] as {
        request: { signal: AbortSignal }
      }
    ).request.signal

    storeState = { ...storeState, setGitStatus: vi.fn(), fetchUpstreamStatus: vi.fn() }
    await rerender(true)

    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)
    expect(firstSignal.aborted).toBe(false)
  })

  it('sweeps after a filesystem event, once the quiet period passes', async () => {
    await mount()
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)

    await act(async () => {
      emitFsChanged()
      await vi.advanceTimersByTimeAsync(399)
    })
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(4)
  })

  it('collapses a burst of filesystem events into a single sweep', async () => {
    // Why: a build writes hundreds of files; one sweep must answer for all of them.
    await mount()

    await act(async () => {
      for (let i = 0; i < 20; i++) {
        emitFsChanged()
      }
      await vi.advanceTimersByTimeAsync(400)
    })

    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(4)
  })

  it('sweeps every workspace on an event, not just the one it names', async () => {
    // Why: an agent can write outside its own worktree by absolute path, so
    // scoping the refresh to the event's path would miss real changes.
    await mount()
    refreshGitStatusForWorktree.mockClear()

    await act(async () => {
      emitFsChanged('/repos/git-1')
      await vi.advanceTimersByTimeAsync(400)
    })

    expect(polledPaths()).toEqual(['/repos/git-1', '/repos/git-2'])
  })

  it('sweeps when an agent changes liveness', async () => {
    await mount()
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)

    storeState = { ...storeState, agentStatusEpoch: 1 }
    await rerender(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(4)
  })

  it('ignores the agent epoch it mounts on', async () => {
    // Why: the mount sweep already covered that state; only a later change means
    // an agent actually moved.
    storeState.agentStatusEpoch = 7

    await mount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)
  })

  it('stops listening for filesystem events when it unmounts', async () => {
    await mount()
    expect(fsListeners).toHaveLength(1)

    await act(async () => {
      root?.unmount()
    })
    root = null

    expect(fsListeners).toHaveLength(0)
  })

  it('polls only the workspaces the sidebar actually renders', async () => {
    // Why: the sidebar hides archived, default-branch, automation-created and
    // filtered-out workspaces. Polling one of those buys a `git status` for a row
    // that never appears, so the sweep follows the rendered set.
    visibleIdsOverride = ['git-1::/repos/git-1']

    await mount()

    expect(polledPaths()).toEqual(['/repos/git-1'])
  })

  it('does not sweep on an event while the window is hidden', async () => {
    // Why: the event paths call sweep() directly, bypassing the interval's own
    // visibility gate, so without a check here a minimised window keeps fanning
    // out one `git status` per workspace.
    await mount()
    refreshGitStatusForWorktree.mockClear()

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    await act(async () => {
      emitFsChanged()
      await vi.advanceTimersByTimeAsync(5_000)
    })

    expect(refreshGitStatusForWorktree).not.toHaveBeenCalled()
  })

  it('defers a request that arrives mid-sweep instead of dropping it', async () => {
    // Why: the in-flight guard used to return without remembering, so a change
    // landing during a slow sweep waited for the next interval tick.
    const releases: (() => void)[] = []
    refreshGitStatusForWorktree.mockImplementation(
      () => new Promise<void>((resolve) => releases.push(resolve))
    )

    await mount()
    await act(async () => {
      emitFsChanged()
      await vi.advanceTimersByTimeAsync(1_000)
    })
    // Still the mount sweep's two calls: the request is held, not run.
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)

    refreshGitStatusForWorktree.mockResolvedValue(undefined)
    await act(async () => {
      releases.forEach((resolve) => resolve())
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(4)
  })

  it('backs off in proportion to how long the last sweep took', async () => {
    // Why: a fixed floor either makes a cheap sweep feel sluggish or fails to
    // bound an expensive one. Here a ~2s sweep must buy ~4s of idle before an
    // event may sweep again, where a fast sweep only waits the quiet period.
    const releases: (() => void)[] = []
    refreshGitStatusForWorktree.mockImplementation(
      () => new Promise<void>((resolve) => releases.push(resolve))
    )

    await mount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
      refreshGitStatusForWorktree.mockResolvedValue(undefined)
      releases.forEach((resolve) => resolve())
    })
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)

    await act(async () => {
      emitFsChanged()
      await vi.advanceTimersByTimeAsync(400)
    })
    // The quiet period alone is not enough after a sweep that cost 2s.
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_700)
    })
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(4)
  })

  it('reuses cached line stats, which the count never displays', async () => {
    // Why: without this every polled workspace re-runs `git diff --numstat` and
    // re-reads each changed untracked file for numbers no row or hover shows.
    await mount()

    expect(refreshGitStatusForWorktree.mock.calls[0][0]).toMatchObject({
      request: { reuseLineStats: true }
    })
  })

  it('never writes upstream state', async () => {
    // Why: porcelain reports Git's configured upstream, which is wrong for a
    // PR-created workspace whose publish target is Orca's own -- writing it would
    // flip Source Control's primary action to "Publish Branch" on a published
    // branch. The count needs no upstream data at all.
    await mount()

    const passedDeps = refreshGitStatusForWorktree.mock.calls[0][0].deps
    passedDeps.setUpstreamStatus('git-1::/repos/git-1', {} as never)
    await passedDeps.fetchUpstreamStatus('git-1::/repos/git-1', '/repos/git-1')

    expect(setUpstreamStatus).not.toHaveBeenCalled()
    expect(fetchUpstreamStatus).not.toHaveBeenCalled()
  })

  it('does not sweep twice when the sidebar is reopened after an agent moved', async () => {
    // Why: the epoch marker went stale while disabled, so the next enable read as
    // an agent transition and added a sweep on top of the mount one.
    await mount()
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)

    await rerender(false)
    storeState = { ...storeState, agentStatusEpoch: 9 }
    await rerender(false)
    refreshGitStatusForWorktree.mockClear()

    await rerender(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    // Only the mount sweep's two calls, not four.
    expect(refreshGitStatusForWorktree).toHaveBeenCalledTimes(2)
  })
})
