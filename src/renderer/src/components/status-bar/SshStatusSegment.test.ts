import { describe, expect, it, vi } from 'vitest'
import { isConnectedRuntimeHostState, runtimeStatusForOverall } from './SshStatusSegment'
import { connectRuntimeHostForNavigation } from './runtime-host-navigation-connect'

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
    const fetchRepos = vi.fn().mockResolvedValue([
      { id: 'repo-a', executionHostId: 'runtime:windows-2' },
      { id: 'repo-b', connectionId: 'legacy-ssh' }
    ])
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
    expect(fetchWorktrees).toHaveBeenNthCalledWith(1, 'repo-a', {
      executionHostId: 'runtime:windows-2'
    })
    expect(fetchWorktrees).toHaveBeenNthCalledWith(2, 'repo-b', {
      executionHostId: 'ssh:legacy-ssh'
    })
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
})
