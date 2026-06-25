import { describe, expect, it, vi } from 'vitest'
import {
  branchHasNoUnmergedChangesOnAnyTarget,
  refreshBranchCleanupTargetRefs,
  type GitBranchCleanupExec
} from './git-branch-cleanup'

function baseProofResponses(
  responses: Partial<Record<string, string | Error>> = {}
): GitBranchCleanupExec {
  return vi.fn<GitBranchCleanupExec>(async (args, options) => {
    if (args[0] === 'patch-id' && options?.stdin === 'branch-diff') {
      const response = responses.branchPatchId ?? 'branch-patch 0000000\n'
      if (response instanceof Error) {
        throw response
      }
      return { stdout: response }
    }
    if (args[0] === 'patch-id' && options?.stdin === 'squash-diff') {
      const response = responses.squashPatchId ?? 'branch-patch squash\n'
      if (response instanceof Error) {
        throw response
      }
      return { stdout: response }
    }
    const key = args.join(' ')
    const response =
      responses[key] ??
      {
        'rev-parse --verify --quiet refs/remotes/origin/main^{commit}': 'target\n',
        'merge-tree --write-tree target refs/heads/feature/test': 'merged-tree\n',
        'rev-parse --verify --quiet target^{tree}': 'target-tree\n',
        'rev-list --right-only --merges --count target...refs/heads/feature/test': '1\n',
        'merge-base target refs/heads/feature/test': 'base\n',
        'diff base refs/heads/feature/test': 'branch-diff',
        'rev-list --ancestry-path --max-count=201 base..target': 'squash\n',
        'show --format= squash': 'squash-diff',
        'merge-tree --write-tree squash refs/heads/feature/test': 'squash-tree\n',
        'rev-parse --verify --quiet squash^{tree}': 'squash-tree\n'
      }[key] ??
      ''
    if (response instanceof Error) {
      throw response
    }
    return { stdout: response }
  })
}

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

describe('branchHasNoUnmergedChangesOnAnyTarget', () => {
  it('accepts a branch with merge commits when a target squash commit matches its net patch', async () => {
    const runGit = baseProofResponses()

    await expect(
      branchHasNoUnmergedChangesOnAnyTarget(runGit, 'feature/test', ['refs/remotes/origin/main'])
    ).resolves.toBe(true)

    expect(runGit).toHaveBeenCalledWith(['patch-id', '--stable'], { stdin: 'branch-diff' })
    expect(runGit).toHaveBeenCalledWith(['patch-id', '--stable'], { stdin: 'squash-diff' })
    expect(runGit).not.toHaveBeenCalledWith(['cherry', '-v', 'target', 'refs/heads/feature/test'])
  })

  it('preserves a branch with merge commits when no target squash commit matches', async () => {
    const runGit = baseProofResponses({ squashPatchId: 'other-patch squash\n' })

    await expect(
      branchHasNoUnmergedChangesOnAnyTarget(runGit, 'feature/test', ['refs/remotes/origin/main'])
    ).resolves.toBe(false)
  })

  it('preserves when a matching squash candidate still changes after merging the branch', async () => {
    const runGit = baseProofResponses({
      'merge-tree --write-tree squash refs/heads/feature/test': 'different-tree\n'
    })

    await expect(
      branchHasNoUnmergedChangesOnAnyTarget(runGit, 'feature/test', ['refs/remotes/origin/main'])
    ).resolves.toBe(false)
  })

  it('preserves when the target squash scan exceeds the cap', async () => {
    const commits = Array.from({ length: 201 }, (_, index) => `commit-${index}`).join('\n')
    const runGit = baseProofResponses({
      'rev-list --ancestry-path --max-count=201 base..target': `${commits}\n`
    })

    await expect(
      branchHasNoUnmergedChangesOnAnyTarget(runGit, 'feature/test', ['refs/remotes/origin/main'])
    ).resolves.toBe(false)

    expect(runGit).not.toHaveBeenCalledWith(['show', '--format=', 'commit-0'])
  })

  it('preserves when patch-id cannot be computed', async () => {
    const runGit = baseProofResponses({ branchPatchId: new Error('patch-id failed') })

    await expect(
      branchHasNoUnmergedChangesOnAnyTarget(runGit, 'feature/test', ['refs/remotes/origin/main'])
    ).resolves.toBe(false)
  })
})
