import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fastForwardLocalBaseBranch,
  inspectLocalBaseBranch,
  parseLocalBaseBranchFastForwardOutcome,
  readFastForwardableBehindCount,
  toLocalBaseRefRefreshResult,
  type LocalBaseBranchGit
} from './local-base-branch-fast-forward'

const REFS = {
  repoPath: '/repo',
  fullRef: 'refs/heads/main',
  remoteTrackingRef: 'refs/remotes/origin/main'
}
const OWNER_MERGE_ARGS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false',
  '-c',
  'merge.autoStash=false',
  '-c',
  'branch.main.mergeOptions=',
  'merge',
  '--ff-only',
  '-s',
  'recursive',
  '--no-verify-signatures',
  '--no-overwrite-ignore',
  '--no-stat',
  '-q',
  'remote-main'
]
const INDEX_LOCK_ERROR = Object.assign(new Error('Command failed: git merge'), {
  stderr: "fatal: Unable to create '/repo-main/.git/index.lock': File exists."
})
const MUTATIONS = new Set(['merge', 'update-ref', 'reset', 'checkout'])

type Reply = { stdout: string } | Error
type Handler = (args: string[], cwd: string) => Reply | Promise<Reply>

/** The git subcommand, past leading global options such as `-c key=value`. */
function commandOf(args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-c') {
      index += 1
    } else if (!args[index].startsWith('-')) {
      return args[index]
    }
  }
  return ''
}

function createFakeGit(
  overrides: Record<string, Handler> = {},
  worktrees: () => { path: string; branch?: string | null }[] | Promise<never> = () => [
    { path: '/repo', branch: 'refs/heads/develop' },
    { path: '/repo-main', branch: 'refs/heads/main' }
  ]
) {
  // Where the local branch points; a successful merge moves it to `afterMerge`, else its target.
  const local: { oid: string; afterMerge?: string } = { oid: 'old-main' }
  const defaults: Record<string, Handler> = {
    'rev-parse': (args) => ({
      stdout: args[2]?.startsWith('refs/heads/') ? `${local.oid}\n` : 'remote-main\n'
    }),
    'rev-list': () => ({ stdout: '0\t3\n' }),
    status: () => ({ stdout: '' }),
    'symbolic-ref': () => ({ stdout: 'refs/heads/main\n' }),
    merge: () => ({ stdout: '' }),
    'update-ref': () => ({ stdout: '' }),
    'show-ref': () => ({ stdout: '' }),
    // Default: local does not contain the target, so a failed move stays a failure.
    'merge-base': () => Object.assign(new Error('not an ancestor'), { code: 1 })
  }
  const calls: { args: string[]; cwd: string }[] = []
  const git: LocalBaseBranchGit = {
    exec: async (args, cwd) => {
      calls.push({ args, cwd })
      const handler = overrides[commandOf(args)] ?? defaults[commandOf(args)]
      if (!handler) {
        throw new Error(`unexpected git ${args.join(' ')}`)
      }
      const reply = await handler(args, cwd)
      if (reply instanceof Error) {
        throw reply
      }
      if (commandOf(args) === 'merge') {
        local.oid = local.afterMerge ?? args.at(-1) ?? ''
      }
      return reply
    },
    listWorktrees: vi.fn(async () => worktrees())
  }
  const commands = () => calls.map(({ args }) => commandOf(args))
  const mutations = () => calls.filter(({ args }) => MUTATIONS.has(commandOf(args)))
  return { git, calls, commands, mutations, local }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('inspectLocalBaseBranch', () => {
  it('has nothing to do when local already matches, without reading worktrees', async () => {
    const fake = createFakeGit({ 'rev-parse': () => ({ stdout: 'same\n' }) })

    await expect(inspectLocalBaseBranch(fake.git, REFS)).resolves.toEqual({
      status: 'nothing_to_do'
    })
    expect(fake.commands()).toEqual(['rev-parse', 'rev-parse'])
    expect(fake.git.listWorktrees).not.toHaveBeenCalled()
  })

  // #15331: a branch that does not exist yet cannot be stale.
  it('has nothing to do when the local branch is proven absent', async () => {
    const fake = createFakeGit({
      'rev-parse': (args) =>
        args[2] === 'refs/heads/main^{commit}' ? new Error('unknown revision') : { stdout: 'x\n' },
      'show-ref': () => Object.assign(new Error('missing'), { code: 1, stderr: '' })
    })

    await expect(inspectLocalBaseBranch(fake.git, REFS)).resolves.toEqual({
      status: 'nothing_to_do'
    })
    expect(fake.calls.at(-1)).toEqual({
      args: ['show-ref', '--verify', '--quiet', '--', 'refs/heads/main'],
      cwd: '/repo'
    })
  })

  it.each([
    ['local is ahead', { 'rev-list': () => ({ stdout: '2\t0\n' }) }],
    ['local diverged', { 'rev-list': () => ({ stdout: '1\t3\n' }) }],
    ['the counts are unreadable', { 'rev-list': () => ({ stdout: 'garbage\n' }) }],
    [
      'the probe fails but the branch exists',
      { 'rev-list': () => new Error('rev-list failed'), 'show-ref': () => ({ stdout: '' }) }
    ],
    [
      'the presence probe itself cannot run',
      {
        'rev-parse': () => new Error('unknown revision'),
        'show-ref': () =>
          Object.assign(new Error('wsl failed'), { code: 1, stderr: 'distro not running' })
      }
    ],
    [
      'the remote-tracking ref resolves to nothing',
      {
        'rev-parse': (args: string[]) => ({
          stdout: args[2] === 'refs/heads/main^{commit}' ? 'old-main\n' : '\n'
        })
      }
    ]
  ] satisfies [string, Record<string, Handler>][])(
    'is not a fast-forward when %s',
    async (_case, overrides) => {
      const fake = createFakeGit(overrides)

      await expect(inspectLocalBaseBranch(fake.git, REFS)).resolves.toEqual({
        status: 'skipped_not_fast_forward'
      })
      expect(fake.mutations()).toEqual([])
    }
  )

  it('compares the resolved oids, not the ref names', async () => {
    const fake = createFakeGit()

    await expect(inspectLocalBaseBranch(fake.git, REFS)).resolves.toEqual({
      status: 'behind',
      behind: 3,
      localOid: 'old-main',
      remoteOid: 'remote-main',
      ownerWorktreePath: '/repo-main'
    })
    expect(fake.calls.slice(0, 3)).toEqual([
      { args: ['rev-parse', '--verify', 'refs/heads/main^{commit}'], cwd: '/repo' },
      { args: ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], cwd: '/repo' },
      { args: ['rev-list', '--left-right', '--count', 'old-main...remote-main'], cwd: '/repo' }
    ])
    expect(fake.mutations()).toEqual([])
  })

  it('reads the owner status without taking optional locks and ignores untracked files', async () => {
    const fake = createFakeGit()

    await inspectLocalBaseBranch(fake.git, REFS)

    expect(fake.calls.find(({ args }) => commandOf(args) === 'status')).toEqual({
      args: ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'],
      cwd: '/repo-main'
    })
  })

  it('reports an error when worktree ownership cannot be listed', async () => {
    const fake = createFakeGit({}, () => Promise.reject(new Error('worktree list failed')))

    await expect(inspectLocalBaseBranch(fake.git, REFS)).resolves.toEqual({
      status: 'skipped_error'
    })
  })
})

describe('fastForwardLocalBaseBranch', () => {
  it('leaves a dirty owner checkout alone', async () => {
    const fake = createFakeGit({ status: () => ({ stdout: ' M package.json\n' }) })

    await expect(fastForwardLocalBaseBranch(fake.git, REFS)).resolves.toEqual({
      status: 'skipped_dirty_worktree',
      ownerWorktreePath: '/repo-main'
    })
    expect(fake.mutations()).toEqual([])
  })

  it('moves a branch no worktree has checked out with a compare-and-swap update-ref', async () => {
    const fake = createFakeGit({}, () => [{ path: '/repo', branch: 'refs/heads/develop' }])

    await expect(fastForwardLocalBaseBranch(fake.git, REFS)).resolves.toEqual({
      status: 'updated'
    })
    expect(fake.mutations()).toEqual([
      {
        args: [
          'update-ref',
          '-m',
          'orca: fast-forward to refs/remotes/origin/main',
          'refs/heads/main',
          'remote-main',
          'old-main'
        ],
        cwd: '/repo'
      }
    ])
    expect(fake.commands()).not.toContain('status')
  })

  it('confirms the owner still has the branch out, then fast-forwards it without hooks', async () => {
    const fake = createFakeGit()

    await expect(fastForwardLocalBaseBranch(fake.git, REFS)).resolves.toEqual({
      status: 'updated',
      ownerWorktreePath: '/repo-main'
    })
    expect(fake.calls.slice(-3)).toEqual([
      { args: ['symbolic-ref', '-q', 'HEAD'], cwd: '/repo-main' },
      { args: OWNER_MERGE_ARGS, cwd: '/repo-main' },
      { args: ['rev-parse', '--verify', 'refs/heads/main^{commit}'], cwd: '/repo' }
    ])
  })

  it('pins the merge options of the branch being moved', async () => {
    const refs = {
      repoPath: '/repo',
      fullRef: 'refs/heads/release/2.0',
      remoteTrackingRef: 'refs/remotes/origin/release/2.0'
    }
    const fake = createFakeGit(
      { 'symbolic-ref': () => ({ stdout: 'refs/heads/release/2.0\n' }) },
      () => [{ path: '/repo-rel', branch: 'refs/heads/release/2.0' }]
    )

    await expect(fastForwardLocalBaseBranch(fake.git, refs)).resolves.toEqual({
      status: 'updated',
      ownerWorktreePath: '/repo-rel'
    })
    expect(fake.mutations()[0]?.args).toContain('branch.release/2.0.mergeOptions=')
  })

  // A merge setting (`-s ours`, `--squash`) the flags failed to override must not read as updated.
  it.each([
    ['created a merge commit instead', 'merge-commit'],
    ['left local where it was', 'old-main']
  ])('reports an error when the merge exits cleanly but %s', async (_case, afterMerge) => {
    const fake = createFakeGit()
    fake.local.afterMerge = afterMerge

    await expect(fastForwardLocalBaseBranch(fake.git, REFS)).resolves.toEqual({
      status: 'skipped_error',
      ownerWorktreePath: '/repo-main'
    })
    expect(fake.calls.at(-1)).toEqual({
      args: ['rev-parse', '--verify', 'refs/heads/main^{commit}'],
      cwd: '/repo'
    })
  })

  // `-c branch.<name>.mergeOptions=` splits at the first `=`, so the pin cannot name this branch.
  it('does not merge into an owner checkout of a branch whose name contains =', async () => {
    const refs = {
      repoPath: '/repo',
      fullRef: 'refs/heads/release=1',
      remoteTrackingRef: 'refs/remotes/origin/release=1'
    }
    const fake = createFakeGit({}, () => [{ path: '/repo-rel', branch: 'refs/heads/release=1' }])

    await expect(fastForwardLocalBaseBranch(fake.git, refs)).resolves.toEqual({
      status: 'skipped_error',
      ownerWorktreePath: '/repo-rel'
    })
    expect(fake.mutations()).toEqual([])
    expect(fake.commands()).not.toContain('symbolic-ref')
  })

  it('still moves a branch whose name contains = when no worktree has it checked out', async () => {
    const refs = {
      repoPath: '/repo',
      fullRef: 'refs/heads/release=1',
      remoteTrackingRef: 'refs/remotes/origin/release=1'
    }
    const fake = createFakeGit({}, () => [])

    await expect(fastForwardLocalBaseBranch(fake.git, refs)).resolves.toEqual({
      status: 'updated'
    })
    expect(fake.mutations().map(({ args }) => args[0])).toEqual(['update-ref'])
  })

  it('does not merge into a checkout that switched branches after the inspection', async () => {
    const fake = createFakeGit({ 'symbolic-ref': () => ({ stdout: 'refs/heads/develop\n' }) })

    await expect(fastForwardLocalBaseBranch(fake.git, REFS)).resolves.toEqual({
      status: 'skipped_error',
      ownerWorktreePath: '/repo-main'
    })
    expect(fake.mutations()).toEqual([])
  })

  it('retries a move that lost an index.lock race', async () => {
    vi.useFakeTimers()
    const merge = vi
      .fn<Handler>()
      .mockReturnValueOnce(INDEX_LOCK_ERROR)
      .mockReturnValueOnce({ stdout: '' })
    const fake = createFakeGit({ merge })

    const pending = fastForwardLocalBaseBranch(fake.git, REFS)
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toEqual({ status: 'updated', ownerWorktreePath: '/repo-main' })
    // Each attempt re-confirms the owner's branch before merging.
    expect(fake.commands().slice(-5)).toEqual([
      'symbolic-ref',
      'merge',
      'symbolic-ref',
      'merge',
      'rev-parse'
    ])
  })

  it('gives up after the retries when the lock never clears and local is still behind', async () => {
    vi.useFakeTimers()
    const fake = createFakeGit({ merge: () => INDEX_LOCK_ERROR })

    const pending = fastForwardLocalBaseBranch(fake.git, REFS)
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toEqual({
      status: 'skipped_error',
      ownerWorktreePath: '/repo-main'
    })
    expect(fake.mutations()).toHaveLength(4)
  })

  it('does not retry a failure that is not lock contention', async () => {
    const casMismatch = Object.assign(new Error('Command failed: git update-ref'), {
      stderr: "fatal: cannot lock ref 'refs/heads/main': is at other but expected old-main"
    })
    const fake = createFakeGit({ 'update-ref': () => casMismatch }, () => [])

    await expect(fastForwardLocalBaseBranch(fake.git, REFS)).resolves.toEqual({
      status: 'skipped_error'
    })
    expect(fake.mutations()).toHaveLength(1)
  })

  it('reports updated when the move failed but local already contains the target', async () => {
    const fake = createFakeGit({
      merge: () => new Error('fatal: Not possible to fast-forward, aborting.'),
      'merge-base': () => ({ stdout: '' })
    })

    await expect(fastForwardLocalBaseBranch(fake.git, REFS)).resolves.toEqual({
      status: 'updated',
      ownerWorktreePath: '/repo-main'
    })
    expect(fake.calls.at(-1)).toEqual({
      args: ['merge-base', '--is-ancestor', 'remote-main', 'refs/heads/main'],
      cwd: '/repo'
    })
  })

  it.each([
    [
      'error: Your local changes to the following files would be overwritten by merge:\n\tREADME.md',
      'skipped_dirty_worktree'
    ],
    [
      'error: The following untracked working tree files would be overwritten by merge:\n\tnew.txt',
      'skipped_dirty_worktree'
    ],
    [
      'error: Updating the following directories would lose untracked files in them:\n\tvendor',
      'skipped_dirty_worktree'
    ],
    ['fatal: Not possible to fast-forward, aborting.', 'skipped_not_fast_forward'],
    ['fatal: unable to write new index file', 'skipped_error']
  ])('classifies a failed merge saying %j as %s', async (stderr, status) => {
    const fake = createFakeGit({
      merge: () => Object.assign(new Error('Command failed: git merge'), { stderr })
    })

    await expect(fastForwardLocalBaseBranch(fake.git, REFS)).resolves.toEqual({
      status,
      ownerWorktreePath: '/repo-main'
    })
  })

  it('passes a non-behind inspection straight through without mutating', async () => {
    const fake = createFakeGit({ 'rev-list': () => ({ stdout: '1\t3\n' }) })

    await expect(fastForwardLocalBaseBranch(fake.git, REFS)).resolves.toEqual({
      status: 'skipped_not_fast_forward'
    })
    expect(fake.mutations()).toEqual([])
  })
})

describe('relay reply parsing', () => {
  it.each([undefined, null, 'updated', {}, { status: 'bogus' }, { status: 'behind', behind: 2 }])(
    'reads the malformed outcome %j as an error',
    (value) => {
      expect(parseLocalBaseBranchFastForwardOutcome(value)).toEqual({ status: 'skipped_error' })
    }
  )

  it.each([
    [{ status: 'nothing_to_do', ownerWorktreePath: '/x' }, { status: 'nothing_to_do' }],
    [{ status: 'updated' }, { status: 'updated' }],
    [
      { status: 'skipped_dirty_worktree', ownerWorktreePath: '/repo-main' },
      { status: 'skipped_dirty_worktree', ownerWorktreePath: '/repo-main' }
    ],
    [{ status: 'updated', ownerWorktreePath: 42 }, { status: 'updated' }],
    [{ status: 'skipped_error', ownerWorktreePath: '' }, { status: 'skipped_error' }]
  ])('keeps only the recognized fields of %j', (value, expected) => {
    expect(parseLocalBaseBranchFastForwardOutcome(value)).toEqual(expected)
  })

  it.each([
    [{ status: 'behind', behind: 3 }, 3],
    [{ status: 'behind', behind: 0 }, undefined],
    [{ status: 'behind', behind: '3' }, undefined],
    [{ status: 'behind' }, undefined],
    [{ status: 'skipped_dirty_worktree', behind: 3 }, undefined],
    [null, undefined],
    [4, undefined]
  ])('reads the behind count of %j as %s', (value, expected) => {
    expect(readFastForwardableBehindCount(value)).toBe(expected)
  })

  it('reports no status when there was nothing to refresh', () => {
    const names = { baseRef: 'origin/main', localBranch: 'main' }

    expect(toLocalBaseRefRefreshResult(names, undefined)).toBeUndefined()
    expect(toLocalBaseRefRefreshResult(names, { status: 'nothing_to_do' })).toBeUndefined()
    expect(
      toLocalBaseRefRefreshResult(names, { status: 'updated', ownerWorktreePath: '/repo-main' })
    ).toEqual({ ...names, status: 'updated', ownerWorktreePath: '/repo-main' })
  })
})
