import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import * as gitOperationLock from '../commands/git-operation-lock'
import { runWithGitFetchHeadLock } from './git-fetch-head-lock'

function observeLockEntries(expected: number) {
  const original = gitOperationLock.runWithGitOperationLock
  let remaining = expected
  let markEntered!: () => void
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve
  })
  const spy = vi
    .spyOn(gitOperationLock, 'runWithGitOperationLock')
    .mockImplementation(
      <T>(key: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> => {
        const pending = original(key, signal, run)
        remaining -= 1
        if (remaining === 0) {
          markEntered()
        }
        return pending
      }
    )
  return { entered, restore: () => spy.mockRestore() }
}

describe('runWithGitFetchHeadLock', () => {
  // Use resolve() because the subject resolves paths; POSIX literals would assert CI-host separators.

  it('serializes FETCH_HEAD users in one worktree without blocking another', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fetch-head-lock-isolation-'))
    const repo = path.join(root, 'repo')
    const otherRepo = path.join(root, 'other')
    await Promise.all([
      mkdir(path.join(repo, '.git'), { recursive: true }),
      mkdir(path.join(otherRepo, '.git'), { recursive: true })
    ])
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const order: string[] = []

    const first = runWithGitFetchHeadLock(repo, undefined, async () => {
      order.push('first:start')
      markFirstStarted()
      await firstGate
      order.push('first:end')
    })
    await firstStarted
    const second = runWithGitFetchHeadLock(repo, undefined, async () => {
      order.push('second')
    })
    const other = runWithGitFetchHeadLock(otherRepo, undefined, async () => {
      order.push('other')
    })

    try {
      await other
      expect(order).toEqual(['first:start', 'other'])
      releaseFirst()
      await Promise.all([first, second])
      expect(order).toEqual(['first:start', 'other', 'first:end', 'second'])
    } finally {
      releaseFirst()
      await Promise.allSettled([first, second, other])
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not run a queued operation after cancellation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fetch-head-lock-cancel-'))
    const repo = path.join(root, 'repo')
    await mkdir(path.join(repo, '.git'), { recursive: true })
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const observation = observeLockEntries(2)
    const first = runWithGitFetchHeadLock(repo, undefined, async () => {
      markFirstStarted()
      await firstGate
    })
    await firstStarted
    const controller = new AbortController()
    const queued = runWithGitFetchHeadLock(repo, controller.signal, async () => 'ran')

    try {
      await observation.entered
      const rejection = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
      controller.abort()
      releaseFirst()
      await rejection
    } finally {
      observation.restore()
      releaseFirst()
      await Promise.allSettled([first, queued])
      await rm(root, { recursive: true, force: true })
    }
  })

  // Windows CI agents usually lack the elevation `symlink` needs.
  it.skipIf(process.platform === 'win32')(
    'serializes root, nested, and symlink aliases of one worktree',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'fetch-head-lock-'))
      const repo = path.join(root, 'repo')
      const nested = path.join(repo, 'nested')
      const alias = path.join(root, 'alias')
      await mkdir(path.join(repo, '.git'), { recursive: true })
      await mkdir(nested)
      await symlink(repo, alias)
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let markFirstStarted!: () => void
      const firstStarted = new Promise<void>((resolve) => {
        markFirstStarted = resolve
      })
      const observation = observeLockEntries(3)
      const pending: Promise<unknown>[] = []
      const order: string[] = []
      try {
        const first = runWithGitFetchHeadLock(repo, undefined, async () => {
          order.push('root')
          markFirstStarted()
          await gate
        })
        pending.push(first)
        await firstStarted
        const nestedRun = runWithGitFetchHeadLock(nested, undefined, async () => {
          order.push('nested')
        })
        pending.push(nestedRun)
        const aliasRun = runWithGitFetchHeadLock(alias, undefined, async () => {
          order.push('alias')
        })
        pending.push(aliasRun)
        await observation.entered
        expect(order).toEqual(['root'])
        release()
        await Promise.all([first, nestedRun, aliasRun])
        expect(order[0]).toBe('root')
        expect(new Set(order.slice(1))).toEqual(new Set(['nested', 'alias']))
      } finally {
        observation.restore()
        release()
        await Promise.allSettled(pending)
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('serializes linked worktrees through their shared Git directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fetch-head-linked-lock-'))
    const main = path.join(root, 'main')
    const linked = path.join(root, 'linked')
    const commonGitDir = path.join(main, '.git')
    const linkedGitDir = path.join(commonGitDir, 'worktrees', 'linked')
    await Promise.all([mkdir(linkedGitDir, { recursive: true }), mkdir(linked)])
    await Promise.all([
      writeFile(path.join(linked, '.git'), `gitdir: ${linkedGitDir}\n`),
      writeFile(path.join(linkedGitDir, 'commondir'), '../..\n')
    ])
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const observation = observeLockEntries(2)
    const order: string[] = []
    const first = runWithGitFetchHeadLock(main, undefined, async () => {
      order.push('main')
      markFirstStarted()
      await gate
    })
    await firstStarted
    const second = runWithGitFetchHeadLock(linked, undefined, async () => {
      order.push('linked')
    })

    try {
      await observation.entered
      expect(order).toEqual(['main'])
      release()
      await Promise.all([first, second])
      expect(order).toEqual(['main', 'linked'])
    } finally {
      observation.restore()
      release()
      await Promise.allSettled([first, second])
      await rm(root, { recursive: true, force: true })
    }
  })
})
