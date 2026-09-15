import { describe, expect, it, vi } from 'vitest'
import {
  branchHasNoUnmergedChangesOnAnyTarget,
  branchHasNoUnmergedChangesWithLazyTargetRefresh,
  refreshBranchCleanupTargetRefs,
  getBranchCleanupTargetRefs,
  type GitBranchCleanupExec
} from './git-branch-cleanup'
import { GitCapabilityCache } from './git-capability-cache'

describe('getBranchCleanupTargetRefs', () => {
  it.each([
    [
      'refs/remotes/upstream/release',
      'refs/remotes/origin/main',
      ['refs/remotes/upstream/release']
    ],
    ['', 'refs/remotes/origin/main', ['refs/remotes/origin/main']],
    ['', '', ['HEAD']]
  ])(
    'uses the saved base, then repository default, then HEAD (%s)',
    async (base, defaultRef, expected) => {
      const runGit = vi.fn<GitBranchCleanupExec>(async (args) => ({
        stdout: String(args[0] === 'config' ? base : defaultRef)
      }))
      expect(await getBranchCleanupTargetRefs(runGit, 'feature/test')).toEqual(expected)
    }
  )
})

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
  it('uses the captured commit for an ancestry proof even if the named branch moved', async () => {
    const runGit = vi.fn<GitBranchCleanupExec>(async (args) => {
      if (args.join(' ') === 'rev-parse --verify --quiet HEAD^{commit}') {
        return { stdout: 'base-tip\n' }
      }
      if (args.join(' ') === 'merge-base base-tip captured-head') {
        return { stdout: 'captured-head\n' }
      }
      throw new Error(`Unexpected proof: ${args.join(' ')}`)
    })
    expect(
      await branchHasNoUnmergedChangesOnAnyTarget(
        runGit,
        'feature/test',
        ['HEAD'],
        new GitCapabilityCache(),
        'captured-head'
      )
    ).toBe(true)
    expect(runGit.mock.calls.flatMap(([args]) => args)).not.toContain('refs/heads/feature/test')
  })

  it('pins the squash and patch-equivalence proofs to the captured commit', async () => {
    const runGit = vi.fn<GitBranchCleanupExec>(async (args) => {
      const responses: Record<string, string> = {
        'rev-parse --verify --quiet HEAD^{commit}': 'base-tip\n',
        'merge-base base-tip captured-head': 'ancestor\n',
        'merge-tree --write-tree base-tip captured-head': 'changed-tree\n',
        'rev-parse --verify --quiet base-tip^{tree}': 'base-tree\n',
        'rev-list --right-only --merges --count base-tip...captured-head': '0\n',
        'cherry -v base-tip captured-head': '- captured-head already integrated\n'
      }
      const response = responses[args.join(' ')]
      if (response === undefined) {
        throw new Error(`Unexpected proof: ${args.join(' ')}`)
      }
      return { stdout: response }
    })
    expect(
      await branchHasNoUnmergedChangesOnAnyTarget(
        runGit,
        'feature/test',
        ['HEAD'],
        new GitCapabilityCache(),
        'captured-head'
      )
    ).toBe(true)
    expect(runGit).toHaveBeenCalledWith(['cherry', '-v', 'base-tip', 'captured-head'], undefined)
  })

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
    expect(runGit).not.toHaveBeenCalledWith(['cherry', '-v', 'target', 'refs/heads/feature/test'])
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

  it.each(['', 'invalid', new Error('history unavailable')])(
    'preserves patch-equivalent commits when merge history cannot be verified (%s)',
    async (mergeCount) => {
      const runGit = baseProofResponses({
        'rev-list --right-only --merges --count target...refs/heads/feature/test': mergeCount,
        'cherry -v target refs/heads/feature/test': '- branch-only patch\n'
      })

      await expect(
        branchHasNoUnmergedChangesOnAnyTarget(
          runGit,
          'feature/test',
          ['refs/remotes/origin/main'],
          new GitCapabilityCache()
        )
      ).resolves.toBe(false)
    }
  )

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

  it('does not repeat a rejected merge-tree --write-tree proof on old Git', async () => {
    const unsupported = Object.assign(new Error('unknown option'), {
      stderr: 'fatal: unknown rev --write-tree'
    })
    const runGit = baseProofResponses({
      'merge-tree --write-tree target refs/heads/feature/test': unsupported,
      'rev-list --right-only --merges --count target...refs/heads/feature/test': '0\n',
      'cherry -v target refs/heads/feature/test': '+ branch-only commit\n'
    })
    const capabilities = new GitCapabilityCache()

    await branchHasNoUnmergedChangesOnAnyTarget(
      runGit,
      'feature/test',
      ['refs/remotes/origin/main'],
      capabilities
    )
    await branchHasNoUnmergedChangesOnAnyTarget(
      runGit,
      'feature/test',
      ['refs/remotes/origin/main'],
      capabilities
    )

    const mergeTreeCalls = vi.mocked(runGit).mock.calls.filter(([args]) => args[0] === 'merge-tree')
    expect(mergeTreeCalls).toHaveLength(1)
  })
})

describe('branchHasNoUnmergedChangesWithLazyTargetRefresh', () => {
  it('skips refresh when local HEAD proves the branch changes are retained', async () => {
    const runGit = vi.fn<GitBranchCleanupExec>(async (args) => {
      const command = args.join(' ')
      const stdout =
        {
          'rev-parse --verify --quiet HEAD^{commit}': 'local-target\n',
          'merge-tree --write-tree local-target refs/heads/feature/test': 'local-tree\n',
          'rev-parse --verify --quiet local-target^{tree}': 'local-tree\n'
        }[command] ?? ''
      return { stdout }
    })

    await expect(
      branchHasNoUnmergedChangesWithLazyTargetRefresh(
        runGit,
        'feature/test',
        ['refs/remotes/origin/main', 'HEAD'],
        new GitCapabilityCache()
      )
    ).resolves.toBe(true)

    expect(runGit.mock.calls.map(([args]) => args)).not.toContainEqual(['remote'])
  })

  it('refreshes before trusting a stale remote-tracking proof', async () => {
    let refreshed = false
    const runGit = vi.fn<GitBranchCleanupExec>(async (args) => {
      const command = args.join(' ')
      if (command === 'remote') {
        return { stdout: 'origin\n' }
      }
      if (command === 'fetch --prune origin') {
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

    expect(runGit.mock.calls.map(([args]) => args)).toContainEqual(['fetch', '--prune', 'origin'])
  })
})
