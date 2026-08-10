import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  resetGitWorktreeCreateLocksForTests,
  withGitWorktreeCreateLock
} from './git-worktree-create-lock'
import { createGitWorktreeDeadline } from './git-worktree-create-timeout'

afterEach(() => resetGitWorktreeCreateLocksForTests())

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function lock(
  target: string,
  operation: () => Promise<void>,
  deadline = createGitWorktreeDeadline(1_000)
): Promise<void> {
  return withGitWorktreeCreateLock({ repository: '/repo/.git', target }, deadline, operation)
}

describe('git worktree create lock', () => {
  it('serializes matching branch names before a loser can inspect ownership', async () => {
    const release = deferred()
    const started: string[] = []
    const first = lock('/one', async () => {
      started.push('first')
      await release.promise
    })
    const second = lock('/two', async () => {
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
    const first = lock('/target', async () => {
      started.push('first')
      await release.promise
    })
    const second = lock('/target', async () => {
      started.push('second')
    })

    await vi.waitFor(() => expect(started).toEqual(['first']))
    release.resolve()
    await Promise.all([first, second])
  })

  it('serializes distinct creates within one repository authority', async () => {
    const release = deferred()
    const started: string[] = []
    const first = lock('/one', async () => {
      started.push('first')
      await release.promise
    })
    const second = lock('/two', async () => {
      started.push('second')
      await release.promise
    })

    await vi.waitFor(() => expect(started).toEqual(['first']))
    release.resolve()
    await Promise.all([first, second])
    expect(started).toEqual(['first', 'second'])
  })

  it('removes an aborted waiter before the predecessor releases', async () => {
    const release = deferred()
    const controller = new AbortController()
    const first = lock('/one', () => release.promise)
    const second = lock(
      '/two',
      async () => {
        throw new Error('aborted waiter ran')
      },
      createGitWorktreeDeadline(1_000, controller.signal)
    )

    controller.abort()
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    release.resolve()
    await first
    await expect(lock('/three', async () => {})).resolves.toBeUndefined()
  })

  it('removes a timed-out waiter before the predecessor releases', async () => {
    vi.useFakeTimers()
    const release = deferred()
    const first = lock('/one', () => release.promise)
    const second = lock(
      '/two',
      async () => {
        throw new Error('timed-out waiter ran')
      },
      createGitWorktreeDeadline(25)
    )

    const rejection = expect(second).rejects.toThrow('timed out during lock queue')
    await vi.advanceTimersByTimeAsync(25)
    await rejection
    release.resolve()
    await first
    await expect(lock('/three', async () => {})).resolves.toBeUndefined()
    vi.useRealTimers()
  })
})
