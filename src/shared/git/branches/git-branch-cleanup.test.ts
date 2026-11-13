import { describe, expect, it, vi } from 'vitest'
import {
  branchHasNoUnmergedChangesWithLazyTargetRefresh,
  type GitBranchCleanupExec
} from './git-branch-cleanup'
import { GitCapabilityCache } from '../commands/git-capability-cache'
import { GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS } from '../fetch/git-fetch-auto-maintenance'

/** Answers the stale remote ref the way a merged branch would: merging it leaves the target tree unchanged. */
function mergedProofResponses(): GitBranchCleanupExec {
  const responses: Record<string, string> = {
    'rev-parse --verify --quiet refs/remotes/origin/main^{commit}': 'target\n',
    'merge-base target refs/heads/feature/test': 'base\n',
    'diff --name-only --no-renames base refs/heads/feature/test': 'feature.txt\n',
    'merge-tree --write-tree target refs/heads/feature/test': 'merged-tree\n',
    'rev-parse --verify --quiet target^{tree}': 'merged-tree\n'
  }
  return vi.fn<GitBranchCleanupExec>(async (args) => ({ stdout: responses[args.join(' ')] ?? '' }))
}

describe('branchHasNoUnmergedChangesWithLazyTargetRefresh', () => {
  it('preserves a branch when refresh fails even if the stale remote ref would prove it merged', async () => {
    const proof = mergedProofResponses()
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
