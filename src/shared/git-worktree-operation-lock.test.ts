import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runWithGitWorktreeOperationLock } from './git-worktree-operation-lock'

describe('git worktree operation lock', () => {
  let root: string | undefined

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true })
      root = undefined
    }
  })

  it('serializes mutations for the same linked worktree path', async () => {
    root = await mkdtemp(join(tmpdir(), 'git-worktree-operation-lock-'))
    const worktreePath = join(root, 'worktree')
    const events: string[] = []
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = runWithGitWorktreeOperationLock(worktreePath, undefined, async () => {
      events.push('first:start')
      markFirstStarted()
      await firstRelease
      events.push('first:end')
    })
    await firstStarted

    const second = runWithGitWorktreeOperationLock(worktreePath, undefined, async () => {
      events.push('second:start')
    })
    await Promise.resolve()
    expect(events).toEqual(['first:start'])

    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'first:end', 'second:start'])
  })
})
