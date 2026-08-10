import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resetGitWorktreeCreateLocksForTests,
  withGitWorktreeCreateLock
} from './git-worktree-create-lock'

afterEach(() => resetGitWorktreeCreateLocksForTests())

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('git worktree create lock', () => {
  it('serializes matching branch names before a loser can inspect ownership', async () => {
    const release = deferred()
    const started: string[] = []
    const first = withGitWorktreeCreateLock('/repo', 'feature', '/one', async () => {
      started.push('first')
      await release.promise
    })
    const second = withGitWorktreeCreateLock('/repo', 'feature', '/two', async () => {
      started.push('second')
    })

    await vi.waitFor(() => expect(started).toEqual(['first']))
    release.resolve()
    await Promise.all([first, second])
    expect(started).toEqual(['first', 'second'])
  })

  it('serializes matching target paths even when branch names differ', async () => {
    const release = deferred()
    const started: string[] = []
    const first = withGitWorktreeCreateLock('/repo', 'one', '/target', async () => {
      started.push('first')
      await release.promise
    })
    const second = withGitWorktreeCreateLock('/repo', 'two', '/target', async () => {
      started.push('second')
    })

    await vi.waitFor(() => expect(started).toEqual(['first']))
    release.resolve()
    await Promise.all([first, second])
  })

  it('preserves concurrency for distinct branches and targets', async () => {
    const release = deferred()
    const started: string[] = []
    const first = withGitWorktreeCreateLock('/repo', 'one', '/one', async () => {
      started.push('first')
      await release.promise
    })
    const second = withGitWorktreeCreateLock('/repo', 'two', '/two', async () => {
      started.push('second')
      await release.promise
    })

    await vi.waitFor(() => expect(started).toEqual(['first', 'second']))
    release.resolve()
    await Promise.all([first, second])
  })
})
