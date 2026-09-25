import { describe, expect, it, vi } from 'vitest'
import { GitCapabilityCache } from '../git-capability-cache'
import {
  addWorktreeWithCheckoutOutsideAdminLock,
  SPLIT_WORKTREE_ADD_CLEANUP_TIMEOUT_MS,
  type SplitWorktreeAddGit
} from './split-worktree-add'

const HEAD = 'a'.repeat(40)

function request(git: SplitWorktreeAddGit, capabilities = new GitCapabilityCache()) {
  return {
    repoPath: '/repo',
    worktreePath: '/wt',
    globalArgs: ['-c', 'core.longpaths=true'],
    addArgs: ['--no-track', '-b', 'feature', '/wt', 'main'],
    git,
    capabilities
  }
}

function gitWith(fail: (args: string[]) => Error | null = () => null) {
  return vi.fn<SplitWorktreeAddGit>(async (args) => {
    const error = fail(args)
    if (error) {
      throw error
    }
    return { stdout: args.includes('rev-parse') ? `${HEAD}\n` : '' }
  })
}

describe('addWorktreeWithCheckoutOutsideAdminLock', () => {
  it('writes admin data with --no-checkout, then checks out and runs post-checkout', async () => {
    const git = gitWith()
    await addWorktreeWithCheckoutOutsideAdminLock(request(git))
    expect(git.mock.calls.map(([args, cwd]) => [cwd, ...args.slice(2)])).toEqual([
      ['/repo', 'hook', 'run', '--ignore-missing', 'orca-capability-probe'],
      ['/repo', 'worktree', 'add', '--no-checkout', '--no-track', '-b', 'feature', '/wt', 'main'],
      ['/wt', 'reset', '--hard', '--no-recurse-submodules'],
      ['/wt', 'rev-parse', 'HEAD'],
      ['/wt', 'hook', 'run', '--ignore-missing', 'post-checkout', '--', '0'.repeat(40), HEAD, '1']
    ])
    expect(git.mock.calls.every(([args]) => args[0] === '-c')).toBe(true)
  })

  it('probes hook support once per capability cache', async () => {
    const capabilities = new GitCapabilityCache()
    await addWorktreeWithCheckoutOutsideAdminLock(request(gitWith(), capabilities))
    const git = gitWith()
    await addWorktreeWithCheckoutOutsideAdminLock(request(git, capabilities))
    expect(git.mock.calls.some(([args]) => args.includes('orca-capability-probe'))).toBe(false)
  })

  it('keeps the plain add, hook included, when Git has no `git hook run`', async () => {
    const capabilities = new GitCapabilityCache()
    const git = gitWith((args) =>
      args.includes('hook')
        ? new Error("git: 'hook' is not a git command. See 'git --help'.")
        : null
    )
    await addWorktreeWithCheckoutOutsideAdminLock(request(git, capabilities))
    expect(git.mock.calls.map(([args]) => args.slice(2))).toEqual([
      ['hook', 'run', '--ignore-missing', 'orca-capability-probe'],
      ['worktree', 'add', '--no-track', '-b', 'feature', '/wt', 'main']
    ])
    expect(capabilities.shouldTry('hook-run')).toBe(false)
  })

  it('removes the worktree, detached and without the admin lane, when the checkout fails', async () => {
    const git = gitWith((args) => (args.includes('reset') ? new Error('checkout failed') : null))
    await expect(addWorktreeWithCheckoutOutsideAdminLock(request(git))).rejects.toThrow(
      'checkout failed'
    )
    expect(git.mock.calls.at(-1)).toEqual([
      ['-c', 'core.longpaths=true', 'worktree', 'remove', '--force', '/wt'],
      '/repo',
      {
        worktreeAdminLock: false,
        detached: true,
        timeout: SPLIT_WORKTREE_ADD_CLEANUP_TIMEOUT_MS
      }
    ])
  })

  it('shares one deadline across the steps instead of a full timeout each', async () => {
    vi.useFakeTimers()
    try {
      const git = vi.fn<SplitWorktreeAddGit>(async (args) => {
        vi.advanceTimersByTime(args.includes('add') ? 600 : 100)
        return { stdout: args.includes('rev-parse') ? `${HEAD}\n` : '' }
      })
      await addWorktreeWithCheckoutOutsideAdminLock({ ...request(git), timeoutMs: 1000 })
      expect(git.mock.calls.map(([, , options]) => options?.timeout)).toEqual([
        1000, 900, 300, 200, 100
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails with a timeout, and cleans up, once the shared deadline is spent', async () => {
    vi.useFakeTimers()
    try {
      const git = vi.fn<SplitWorktreeAddGit>(async (args) => {
        vi.advanceTimersByTime(args.includes('add') ? 1000 : 0)
        return { stdout: '' }
      })
      await expect(
        addWorktreeWithCheckoutOutsideAdminLock({ ...request(git), timeoutMs: 1000 })
      ).rejects.toMatchObject({ code: 'ETIMEDOUT' })
      expect(git.mock.calls.some(([args]) => args.includes('reset'))).toBe(false)
      expect(git.mock.calls.at(-1)?.[0]).toContain('remove')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails the create but keeps the worktree when post-checkout fails', async () => {
    const git = gitWith((args) =>
      args.includes('post-checkout') ? new Error('hook exited with 1') : null
    )
    await expect(addWorktreeWithCheckoutOutsideAdminLock(request(git))).rejects.toThrow(
      'hook exited with 1'
    )
    expect(git.mock.calls.some(([args]) => args.includes('remove'))).toBe(false)
  })

  it('reports the admin write even when the add itself fails', async () => {
    const afterAdminWrite = vi.fn()
    const git = gitWith((args) => (args.includes('add') ? new Error('already exists') : null))
    await expect(
      addWorktreeWithCheckoutOutsideAdminLock({ ...request(git), afterAdminWrite })
    ).rejects.toThrow('already exists')
    expect(afterAdminWrite).toHaveBeenCalledOnce()
  })
})
