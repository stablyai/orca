import { describe, expect, it, vi } from 'vitest'
import { refreshBranchCleanupTargetRefs, type GitBranchCleanupExec } from './git-branch-cleanup'

describe('refreshBranchCleanupTargetRefs', () => {
  it('fetches each remote-tracking target remote once and prefers slashed remote names', async () => {
    const runGit = vi.fn<GitBranchCleanupExec>(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\nfoo\nfoo/bar\n' }
      }
      return { stdout: '' }
    })

    await refreshBranchCleanupTargetRefs(runGit, [
      'refs/remotes/origin/main',
      'refs/remotes/foo/bar/feature',
      'refs/remotes/foo/bar/another',
      'HEAD'
    ])

    expect(runGit.mock.calls.map((call) => call[0])).toEqual([
      ['remote'],
      ['fetch', '--prune', 'origin'],
      ['fetch', '--prune', 'foo/bar']
    ])
  })

  it('keeps cleanup non-fatal when listing or fetching remotes fails', async () => {
    const remoteListFails = vi.fn<GitBranchCleanupExec>().mockRejectedValue(new Error('offline'))

    await expect(
      refreshBranchCleanupTargetRefs(remoteListFails, ['refs/remotes/origin/main'])
    ).resolves.toBeUndefined()

    const fetchFails = vi.fn<GitBranchCleanupExec>(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n' }
      }
      throw new Error('offline')
    })

    await expect(
      refreshBranchCleanupTargetRefs(fetchFails, ['refs/remotes/origin/main'])
    ).resolves.toBeUndefined()
  })
})
