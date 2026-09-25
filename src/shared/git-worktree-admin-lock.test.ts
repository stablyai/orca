import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitCommonDirLocationModule from './git-common-dir-location'

const mocks = vi.hoisted(() => {
  const state: { resolveFailure: Error | null; resolveCalls: number } = {
    resolveFailure: null,
    resolveCalls: 0
  }
  return state
})

vi.mock('./git-common-dir-location', async (importOriginal) => {
  const actual = await importOriginal<typeof GitCommonDirLocationModule>()
  return {
    ...actual,
    resolveCanonicalGitCommonDir: (
      ...args: Parameters<typeof actual.resolveCanonicalGitCommonDir>
    ) => {
      mocks.resolveCalls += 1
      if (mocks.resolveFailure) {
        return Promise.reject(mocks.resolveFailure)
      }
      return actual.resolveCanonicalGitCommonDir(...args)
    }
  }
})

import {
  _resetGitWorktreeAdminLockCacheForTests,
  _resolveGitWorktreeAdminLockKeyForTests,
  resolveGitWorktreeAdminCommand,
  runWithGitWorktreeAdminLock
} from './git-worktree-admin-lock'
import { _gitOperationLockWaiterCountForTests } from './git-operation-lock'

describe('resolveGitWorktreeAdminCommand', () => {
  it.each([
    [['worktree', 'add', '--detach', '/w', 'main'], true],
    [['-c', 'core.longpaths=true', 'worktree', 'remove', '--force', '/w'], true],
    [['worktree', 'move', '-f', '-f', '/a', '/b'], true],
    [['worktree', 'lock', '--reason', 'x', '/w'], true],
    [['worktree', 'unlock', '/w'], true],
    [['worktree', 'repair'], true],
    [['worktree', 'prune'], true],
    [['worktree', 'list', '--porcelain'], false],
    [['status', '--short'], false],
    [['fetch', 'origin'], false]
  ])('%j -> %s', (args, expected) => {
    expect(resolveGitWorktreeAdminCommand(args, '/repo') !== null).toBe(expected)
  })

  it('follows -C to the repository the command addresses', () => {
    expect(resolveGitWorktreeAdminCommand(['-C', 'sub', 'worktree', 'prune'], '/repo')).toEqual({
      cwd: path.resolve('/repo', 'sub')
    })
  })
})

describe('runWithGitWorktreeAdminLock', () => {
  let root: string
  let repoPath: string
  let linkedPath: string

  beforeEach(async () => {
    mocks.resolveFailure = null
    mocks.resolveCalls = 0
    _resetGitWorktreeAdminLockCacheForTests()
    root = await mkdtemp(path.join(tmpdir(), 'git-worktree-admin-lock-'))
    repoPath = path.join(root, 'repo')
    linkedPath = path.join(root, 'linked')
    await mkdir(path.join(repoPath, '.git', 'worktrees', 'linked'), { recursive: true })
    await writeFile(path.join(repoPath, '.git', 'worktrees', 'linked', 'commondir'), '../..\n')
    await mkdir(linkedPath, { recursive: true })
    await writeFile(
      path.join(linkedPath, '.git'),
      `gitdir: ${path.join(repoPath, '.git', 'worktrees', 'linked')}\n`
    )
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('serializes mutations issued from the main checkout and a linked worktree of one repo', async () => {
    expect(await _resolveGitWorktreeAdminLockKeyForTests(linkedPath)).toBe(
      await _resolveGitWorktreeAdminLockKeyForTests(repoPath)
    )
    const order: string[] = []
    let releaseFirst!: () => void
    const first = runWithGitWorktreeAdminLock({ cwd: repoPath }, undefined, async () => {
      order.push('first:start')
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      order.push('first:end')
    })
    await vi.waitFor(() => expect(order).toEqual(['first:start']))
    const second = runWithGitWorktreeAdminLock({ cwd: linkedPath }, undefined, async () => {
      order.push('second')
    })
    const key = await _resolveGitWorktreeAdminLockKeyForTests(repoPath)
    await vi.waitFor(() => expect(_gitOperationLockWaiterCountForTests(key)).toBe(1))
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })

  it('resolves the common dir once per repository path', async () => {
    for (let index = 0; index < 3; index += 1) {
      await runWithGitWorktreeAdminLock({ cwd: repoPath }, undefined, async () => {})
    }
    expect(mocks.resolveCalls).toBe(1)
  })

  it('runs the command unlocked when the lock key cannot be derived', async () => {
    mocks.resolveFailure = new Error('EIO reading .git')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(
        runWithGitWorktreeAdminLock({ cwd: repoPath }, undefined, async () => 'ran')
      ).resolves.toBe('ran')
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it('does not re-run a command whose own failure is not a lock failure', async () => {
    const run = vi.fn(async () => {
      throw new Error('fatal: worktree already exists')
    })
    await expect(runWithGitWorktreeAdminLock({ cwd: repoPath }, undefined, run)).rejects.toThrow(
      'already exists'
    )
    expect(run).toHaveBeenCalledOnce()
  })

  it('runs a command unlocked with a warning when the lane stays busy past the bound', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let releaseFirst!: () => void
    const started = Promise.withResolvers<void>()
    const first = runWithGitWorktreeAdminLock({ cwd: repoPath }, undefined, async () => {
      started.resolve()
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
    })
    try {
      await started.promise
      const held = await runWithGitWorktreeAdminLock(
        { cwd: repoPath },
        undefined,
        async (lease) => lease.held,
        { maxWaitMs: 5 }
      )
      expect(held).toBe(false)
      expect(warn).toHaveBeenCalledWith(
        '[git] worktree admin lock still busy after 5 ms; running unlocked'
      )
    } finally {
      releaseFirst()
      await first
      warn.mockRestore()
    }
  })

  it('propagates cancellation during key derivation instead of running unlocked', async () => {
    const controller = new AbortController()
    controller.abort()
    mocks.resolveFailure = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const run = vi.fn(async () => 'ran')
    await expect(
      runWithGitWorktreeAdminLock({ cwd: repoPath }, controller.signal, run)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(run).not.toHaveBeenCalled()
  })
})
