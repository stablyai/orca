import { describe, expect, it, vi } from 'vitest'
import {
  noteWorkspaceMetadataRecord,
  requireWorkspaceMetadataCoverage,
  workspaceMetadataListingCoverage
} from './workspace-metadata-coverage'
import { requestWorkspaceMetadataRecovery } from './workspace-metadata-recovery'

describe('workspace metadata listing coverage', () => {
  it('a missed record makes every repo of that producer wait for a listing that includes it', () => {
    expect(noteWorkspaceMetadataRecord('local', 'gap', 1, 'repo-a')).toEqual({
      replayed: false,
      gap: false
    })
    expect(noteWorkspaceMetadataRecord('local', 'gap', 3, 'repo-a').gap).toBe(true)
    requireWorkspaceMetadataCoverage('local', ['repo-a', 'repo-b'])

    expect(workspaceMetadataListingCoverage('local', 'repo-b', { epoch: 'gap', seq: 2 })).toBe(
      'stale'
    )
    expect(workspaceMetadataListingCoverage('local', 'repo-b', { epoch: 'gap', seq: 3 })).toBe(
      'covered'
    )
    // An older host's listing carries no stamp and changes nothing.
    expect(workspaceMetadataListingCoverage('local', 'repo-b', undefined)).toBe('unknown')
  })

  it("a restarted producer's listing already includes what it wrote before", () => {
    noteWorkspaceMetadataRecord('env:e1:1:1', 'before', 9, 'repo-a')
    expect(
      workspaceMetadataListingCoverage('env:e1:1:1', 'repo-a', { epoch: 'after', seq: 1 })
    ).toBe('covered')
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
      forceFresh: true
    })

    finish()
    await vi.waitFor(() => expect(fetchWorktrees).toHaveBeenCalledTimes(2))
    finish()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fetchWorktrees).toHaveBeenCalledTimes(2)
  })
})
