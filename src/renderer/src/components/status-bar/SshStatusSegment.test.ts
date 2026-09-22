import { describe, expect, it, vi } from 'vitest'
import { connectRuntimeHostForNavigation } from './SshStatusSegment'

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
    expect(fetchWorktrees).toHaveBeenNthCalledWith(1, 'repo-a', {
      executionHostId: 'runtime:windows-2',
      suppressRemoteLineageRefresh: true
    })
    expect(fetchWorktrees).toHaveBeenNthCalledWith(2, 'repo-b', {
      executionHostId: 'runtime:windows-2',
      suppressRemoteLineageRefresh: true
    })
    expect(fetchLineage).toHaveBeenCalledOnce()
    expect(fetchLineage).toHaveBeenCalledWith({ executionHostId: 'runtime:windows-2' })
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
