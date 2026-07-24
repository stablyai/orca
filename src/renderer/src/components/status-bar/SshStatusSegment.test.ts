import { describe, expect, it, vi } from 'vitest'
import {
  connectRuntimeHostForNavigation,
  isConnectedRuntimeHostState,
  RUNTIME_HOST_CATALOG_FETCH_CONCURRENCY,
  runtimeStatusForOverall
} from './SshStatusSegment'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  return {
    promise: new Promise<void>((nextResolve) => {
      resolve = nextResolve
    }),
    resolve
  }
}

describe('SshStatusSegment host status helpers', () => {
  it('counts connected remote servers as connected hosts', () => {
    // Why: "connected" = attached/reachable (active-agnostic), matching Settings.
    // There is no separate "available" state — a reachable host is just Connected.
    expect(runtimeStatusForOverall('connected')).toBe('connected')
    expect(isConnectedRuntimeHostState('connected')).toBe(true)
  })

  it('keeps reconnecting and disconnected remote servers out of the connected count', () => {
    expect(runtimeStatusForOverall('reconnecting')).toBe('connecting')
    expect(runtimeStatusForOverall('disconnected')).toBe('disconnected')
    expect(isConnectedRuntimeHostState('reconnecting')).toBe(false)
    expect(isConnectedRuntimeHostState('disconnected')).toBe(false)
  })
})

describe('connectRuntimeHostForNavigation', () => {
  it('loads the transient host catalog without writing Active Server', async () => {
    const refreshStatus = vi.fn().mockResolvedValue(true)
    const fetchRepos = vi.fn().mockResolvedValue([{ id: 'repo-a' }, { id: 'repo-b' }])
    const fetchWorktrees = vi.fn().mockResolvedValue(undefined)
    const fetchLineage = vi.fn().mockResolvedValue(undefined)

    await expect(
      connectRuntimeHostForNavigation({
        environmentId: 'windows-2',
        refreshStatus,
        fetchRepos,
        fetchWorktrees,
        fetchLineage
      })
    ).resolves.toBe(true)

    expect(fetchRepos).toHaveBeenCalledWith('windows-2')
    expect(fetchWorktrees).toHaveBeenCalledTimes(2)
    expect(fetchLineage).toHaveBeenCalledOnce()
  })

  it('does not load a catalog when the server is unreachable', async () => {
    const fetchRepos = vi.fn()
    await expect(
      connectRuntimeHostForNavigation({
        environmentId: 'windows-2',
        refreshStatus: vi.fn().mockResolvedValue(false),
        fetchRepos,
        fetchWorktrees: vi.fn(),
        fetchLineage: vi.fn()
      })
    ).resolves.toBe(false)
    expect(fetchRepos).not.toHaveBeenCalled()
  })

  it('bounds catalog worktree fetches for large remote hosts', async () => {
    const count = RUNTIME_HOST_CATALOG_FETCH_CONCURRENCY + 1
    const releases = Array.from({ length: count }, deferred)
    let active = 0
    let peak = 0
    const fetchWorktrees = vi.fn(async (_repoId: string) => {
      const release = releases[fetchWorktrees.mock.calls.length - 1]
      active += 1
      peak = Math.max(peak, active)
      await release.promise
      active -= 1
    })
    const loading = connectRuntimeHostForNavigation({
      environmentId: 'windows-2',
      refreshStatus: vi.fn().mockResolvedValue(true),
      fetchRepos: vi
        .fn()
        .mockResolvedValue(Array.from({ length: count }, (_, index) => ({ id: `repo-${index}` }))),
      fetchWorktrees,
      fetchLineage: vi.fn().mockResolvedValue(undefined)
    })

    await vi.waitFor(() =>
      expect(fetchWorktrees).toHaveBeenCalledTimes(RUNTIME_HOST_CATALOG_FETCH_CONCURRENCY)
    )
    releases[0].resolve()
    await vi.waitFor(() => expect(fetchWorktrees).toHaveBeenCalledTimes(count))
    releases.slice(1).forEach(({ resolve }) => resolve())
    await expect(loading).resolves.toBe(true)
    expect(peak).toBe(RUNTIME_HOST_CATALOG_FETCH_CONCURRENCY)
  })
})
