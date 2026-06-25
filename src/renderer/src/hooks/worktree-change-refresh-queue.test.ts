import { describe, expect, it, vi } from 'vitest'
import { createWorktreeChangeRefreshQueue } from './worktree-change-refresh-queue'

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('createWorktreeChangeRefreshQueue', () => {
  it('coalesces same-repo change bursts behind the active refresh', async () => {
    const firstRefresh = deferred()
    const handler = vi.fn(() => firstRefresh.promise)
    const queue = createWorktreeChangeRefreshQueue(handler)

    queue.enqueue({ repoId: 'repo-1' })
    queue.enqueue({ repoId: 'repo-1' })
    queue.enqueue({ repoId: 'repo-1' })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('repo-1', undefined)

    firstRefresh.resolve()
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenNthCalledWith(2, 'repo-1', undefined)
  })

  it('does not overlap refreshes for the same repo', async () => {
    const firstRefresh = deferred()
    const secondRefresh = deferred()
    const handler = vi
      .fn()
      .mockReturnValueOnce(firstRefresh.promise)
      .mockReturnValueOnce(secondRefresh.promise)
    const queue = createWorktreeChangeRefreshQueue(handler)

    queue.enqueue({ repoId: 'repo-1' })
    queue.enqueue({ repoId: 'repo-1' })

    expect(handler).toHaveBeenCalledTimes(1)

    firstRefresh.resolve()
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(2)

    secondRefresh.resolve()
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('runs different repos independently', async () => {
    const repoOneRefresh = deferred()
    const handler = vi.fn((repoId: string) =>
      repoId === 'repo-1' ? repoOneRefresh.promise : Promise.resolve()
    )
    const queue = createWorktreeChangeRefreshQueue(handler)

    queue.enqueue({ repoId: 'repo-1' })
    queue.enqueue({ repoId: 'repo-2' })

    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler).toHaveBeenNthCalledWith(1, 'repo-1', undefined)
    expect(handler).toHaveBeenNthCalledWith(2, 'repo-2', undefined)

    repoOneRefresh.resolve()
    await flushPromises()
  })

  it('continues draining queued refreshes after a failed refresh', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const firstRefresh = deferred()
      const handler = vi
        .fn()
        .mockReturnValueOnce(firstRefresh.promise)
        .mockRejectedValueOnce(new Error('refresh failed'))
        .mockResolvedValue(undefined)
      const queue = createWorktreeChangeRefreshQueue(handler)
      const renamed = { oldWorktreeId: 'wt-old', newWorktreeId: 'wt-new' }

      queue.enqueue({ repoId: 'repo-1' })
      queue.enqueue({ repoId: 'repo-1', renamed })
      queue.enqueue({ repoId: 'repo-1' })

      firstRefresh.resolve()
      await flushPromises()

      expect(handler).toHaveBeenCalledTimes(3)
      expect(handler).toHaveBeenNthCalledWith(2, 'repo-1', renamed)
      expect(handler).toHaveBeenNthCalledWith(3, 'repo-1', undefined)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('preserves rename events instead of folding them into plain refreshes', async () => {
    const handler = vi.fn(() => Promise.resolve())
    const queue = createWorktreeChangeRefreshQueue(handler)
    const renamed = { oldWorktreeId: 'wt-old', newWorktreeId: 'wt-new' }

    queue.enqueue({ repoId: 'repo-1' })
    queue.enqueue({ repoId: 'repo-1', renamed })
    await flushPromises()

    expect(handler).toHaveBeenNthCalledWith(1, 'repo-1', undefined)
    expect(handler).toHaveBeenNthCalledWith(2, 'repo-1', renamed)
  })

  it('keeps a plain refresh queued after a rename', async () => {
    const firstRefresh = deferred()
    const handler = vi.fn().mockReturnValueOnce(firstRefresh.promise).mockResolvedValue(undefined)
    const queue = createWorktreeChangeRefreshQueue(handler)
    const renamed = { oldWorktreeId: 'wt-old', newWorktreeId: 'wt-new' }

    queue.enqueue({ repoId: 'repo-1' })
    queue.enqueue({ repoId: 'repo-1', renamed })
    queue.enqueue({ repoId: 'repo-1' })

    expect(handler).toHaveBeenCalledTimes(1)

    firstRefresh.resolve()
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(3)
    expect(handler).toHaveBeenNthCalledWith(2, 'repo-1', renamed)
    expect(handler).toHaveBeenNthCalledWith(3, 'repo-1', undefined)
  })

  it('drops queued trailing refreshes after disposal', async () => {
    const firstRefresh = deferred()
    const handler = vi.fn().mockReturnValueOnce(firstRefresh.promise).mockResolvedValue(undefined)
    const queue = createWorktreeChangeRefreshQueue(handler)

    queue.enqueue({ repoId: 'repo-1' })
    queue.enqueue({ repoId: 'repo-1' })
    queue.dispose()

    firstRefresh.resolve()
    await flushPromises()

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('ignores new events after disposal', async () => {
    const handler = vi.fn(() => Promise.resolve())
    const queue = createWorktreeChangeRefreshQueue(handler)

    queue.dispose()
    queue.enqueue({ repoId: 'repo-1' })
    await flushPromises()

    expect(handler).not.toHaveBeenCalled()
  })
})
