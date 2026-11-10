import { describe, expect, it, vi } from 'vitest'
import {
  noteWorkspaceMetadataRecord,
  requireWorkspaceMetadataCoverage,
  workspaceMetadataListingCoverage
} from './workspace-metadata-coverage'
import { requestWorkspaceMetadataRecovery } from './workspace-metadata-recovery'

const listed = () => true

describe('workspace metadata listing coverage', () => {
  it('a missed record makes every repo of that producer wait for a listing that includes it', () => {
    expect(noteWorkspaceMetadataRecord('local', 'gap', 1, 'repo-a', 'local', listed)).toEqual({
      replayed: false,
      gap: false
    })
    expect(noteWorkspaceMetadataRecord('local', 'gap', 3, 'repo-a', 'local', listed).gap).toBe(true)
    requireWorkspaceMetadataCoverage('local', [
      { repoId: 'repo-a', hostId: 'local' },
      { repoId: 'repo-b', hostId: 'ssh:box' }
    ])

    expect(
      workspaceMetadataListingCoverage('local', 'repo-b', 'ssh:box', { epoch: 'gap', seq: 2 })
    ).toBe('stale')
    expect(
      workspaceMetadataListingCoverage('local', 'repo-b', 'ssh:box', { epoch: 'gap', seq: 3 })
    ).toBe('covered')
    // The same repo listed on another host is a different projection.
    expect(
      workspaceMetadataListingCoverage('local', 'repo-b', 'local', { epoch: 'gap', seq: 0 })
    ).toBe('unknown')

    // A later gap after repo-b was removed forgets it.
    noteWorkspaceMetadataRecord('local', 'gap', 5, 'repo-a', 'local', listed)
    requireWorkspaceMetadataCoverage('local', [{ repoId: 'repo-a', hostId: 'local' }])
    expect(
      workspaceMetadataListingCoverage('local', 'repo-b', 'ssh:box', { epoch: 'gap', seq: 5 })
    ).toBe('unknown')
  })

  it("another producer run's listing keeps titles without claiming to cover them", () => {
    noteWorkspaceMetadataRecord('env:e1:1:1', 'before', 9, 'repo-a', 'runtime:e1', listed)
    expect(
      workspaceMetadataListingCoverage('env:e1:1:1', 'repo-a', 'runtime:e1', {
        epoch: 'after',
        seq: 1
      })
    ).toBe('unstamped')
  })
})

describe('workspace metadata recovery listing', () => {
  it('runs one fresh listing at a time and once more for requests made during it', async () => {
    let finish: () => void = () => {}
    const fetchWorktrees = vi.fn(
      () => new Promise<unknown>((resolve) => (finish = () => resolve(true)))
    )

    requestWorkspaceMetadataRecovery('repo-a', 'local', fetchWorktrees)
    requestWorkspaceMetadataRecovery('repo-a', 'local', fetchWorktrees)
    requestWorkspaceMetadataRecovery('repo-a', 'local', fetchWorktrees)
    expect(fetchWorktrees).toHaveBeenCalledTimes(1)
    expect(fetchWorktrees).toHaveBeenCalledWith('repo-a', {
      forceLocalOwner: true,
      forceFresh: true,
      suppressRemoteLineageRefresh: true
    })

    finish()
    await vi.waitFor(() => expect(fetchWorktrees).toHaveBeenCalledTimes(2))
    finish()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchWorktrees).toHaveBeenCalledTimes(2)
  })
})
