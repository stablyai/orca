import { describe, expect, it, vi } from 'vitest'
import {
  branchHasNoUnmergedChangesOnAnyTarget,
  branchHasNoUnmergedChangesWithLazyTargetRefresh,
  type GitBranchCleanupExec
} from './git-branch-cleanup'
import { GitCapabilityCache } from '../commands/git-capability-cache'
import { GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS } from '../fetch/git-fetch-auto-maintenance'

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

describe('branchHasNoUnmergedChangesOnAnyTarget', () => {
  it('accepts a branch with merge commits when a target squash commit matches its net patch', async () => {
    const runGit = baseProofResponses()

    await expect(
      branchHasNoUnmergedChangesOnAnyTarget(
        runGit,
        'feature/test',
        ['refs/remotes/origin/main'],
        new GitCapabilityCache()
      )
    ).resolves.toBe(true)

    expect(runGit).toHaveBeenCalledWith(['patch-id', '--stable'], { stdin: 'branch-diff' })
    expect(runGit).toHaveBeenCalledWith(['patch-id', '--stable'], { stdin: 'squash-diff' })
    expect(runGit).not.toHaveBeenCalledWith(['cherry', 'target', 'refs/heads/feature/test'])
    // Only merge-tree's throwaway tree writes go to a scratch object store.
    const discarding = vi
      .mocked(runGit)
      .mock.calls.filter(([, options]) => options?.discardWrittenObjects)
      .map(([args]) => args[0])
    expect(discarding.length).toBeGreaterThan(0)
    expect(new Set(discarding)).toEqual(new Set(['merge-tree']))
  })

  it('preserves a branch with merge commits when no target squash commit matches', async () => {
    const runGit = baseProofResponses({ squashPatchId: 'other-patch squash\n' })

    await expect(
      branchHasNoUnmergedChangesOnAnyTarget(
        runGit,
        'feature/test',
        ['refs/remotes/origin/main'],
        new GitCapabilityCache()
      )
    ).resolves.toBe(false)
  })

  it('preserves when a matching squash candidate still changes after merging the branch', async () => {
    const runGit = baseProofResponses({
      'merge-tree --write-tree squash refs/heads/feature/test': 'different-tree\n'
    })

    await expect(
      branchHasNoUnmergedChangesOnAnyTarget(
        runGit,
        'feature/test',
        ['refs/remotes/origin/main'],
        new GitCapabilityCache()
      )
    ).resolves.toBe(false)
  })

  it('preserves when the target squash scan exceeds the cap', async () => {
    const commits = Array.from({ length: 201 }, (_, index) => `commit-${index}`).join('\n')
    const runGit = baseProofResponses({
      'rev-list --ancestry-path --max-count=201 base..target': `${commits}\n`
    })

    await expect(
      branchHasNoUnmergedChangesOnAnyTarget(
        runGit,
        'feature/test',
        ['refs/remotes/origin/main'],
        new GitCapabilityCache()
      )
    ).resolves.toBe(false)

    expect(runGit).not.toHaveBeenCalledWith(['show', '--format=', 'commit-0'])
  })

  it('preserves when patch-id cannot be computed', async () => {
    const runGit = baseProofResponses({ branchPatchId: new Error('patch-id failed') })

    await expect(
      branchHasNoUnmergedChangesOnAnyTarget(
        runGit,
        'feature/test',
        ['refs/remotes/origin/main'],
        new GitCapabilityCache()
      )
    ).resolves.toBe(false)
  })
})

describe('branchHasNoUnmergedChangesWithLazyTargetRefresh', () => {
  it('preserves a branch when refresh fails even if the stale remote ref would prove it merged', async () => {
    const proof = baseProofResponses({
      'rev-parse --verify --quiet target^{tree}': 'merged-tree\n'
    })
    const runGit = vi.fn<GitBranchCleanupExec>(async (args, options) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n' }
      }
      if (args[0] === 'config') {
        return { stdout: '+refs/heads/*:refs/remotes/origin/*\n' }
      }
      if (args.includes('fetch')) {
        throw new Error('offline')
      }
      return proof(args, options)
    })

    await expect(
      branchHasNoUnmergedChangesWithLazyTargetRefresh(
        runGit,
        'feature/test',
        ['refs/remotes/origin/main'],
        new GitCapabilityCache()
      )
    ).resolves.toBe(false)
    expect(proof).not.toHaveBeenCalled()
  })

  it('refreshes before trusting a stale remote-tracking proof', async () => {
    let refreshed = false
    const runGit = vi.fn<GitBranchCleanupExec>(async (args) => {
      const command = args.join(' ')
      if (command === 'remote') {
        return { stdout: 'origin\n' }
      }
      if (args[0] === 'config') {
        return { stdout: '+refs/heads/*:refs/remotes/origin/*\n' }
      }
      if (args.includes('fetch')) {
        refreshed = true
        return { stdout: '' }
      }
      if (command === 'rev-parse --verify --quiet refs/remotes/origin/main^{commit}') {
        return { stdout: 'remote-target\n' }
      }
      if (command === 'rev-parse --verify --quiet origin/main^{commit}') {
        return { stdout: 'short-remote-target\n' }
      }
      if (command === 'rev-parse --verify --quiet HEAD^{commit}') {
        return { stdout: 'local-target\n' }
      }
      if (args[0] === 'merge-base') {
        return { stdout: 'base\n' }
      }
      if (command === 'merge-tree --write-tree remote-target refs/heads/feature/test') {
        return { stdout: refreshed ? 'changed-tree\n' : 'remote-tree\n' }
      }
      if (command === 'merge-tree --write-tree short-remote-target refs/heads/feature/test') {
        return { stdout: refreshed ? 'changed-tree\n' : 'short-remote-tree\n' }
      }
      if (command === 'rev-parse --verify --quiet remote-target^{tree}') {
        return { stdout: 'remote-tree\n' }
      }
      if (command === 'rev-parse --verify --quiet short-remote-target^{tree}') {
        return { stdout: 'short-remote-tree\n' }
      }
      return { stdout: '' }
    })

    await expect(
      branchHasNoUnmergedChangesWithLazyTargetRefresh(
        runGit,
        'feature/test',
        ['refs/remotes/origin/main', 'origin/main', 'HEAD'],
        new GitCapabilityCache()
      )
    ).resolves.toBe(false)

    expect(runGit.mock.calls.map(([args]) => args)).toContainEqual([
      ...GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS,
      'fetch',
      '--no-tags',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main'
    ])
  })
})
