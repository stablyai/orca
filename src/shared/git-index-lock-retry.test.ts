import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_INDEX_LOCK_RETRY_DELAYS_MS,
  isGitIndexLockError,
  runWithGitIndexLockRetry
} from './git-index-lock-retry'

describe('git index lock retry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('recognizes Git index lock contention', () => {
    expect(
      isGitIndexLockError(
        Object.assign(new Error('Command failed'), {
          stderr: "fatal: Unable to create '/repo/.git/index.lock': File exists"
        })
      )
    ).toBe(true)
    expect(isGitIndexLockError(new Error('fatal: not a git repository'))).toBe(false)
  })

  it('rethrows a non-lock failure without retrying', async () => {
    vi.useFakeTimers()
    const failure = new Error('fatal: pathspec did not match any files')
    const run = vi.fn<() => Promise<string>>().mockRejectedValue(failure)

    await expect(runWithGitIndexLockRetry(run)).rejects.toBe(failure)
    expect(run).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries a lock failure and preserves other failures', async () => {
    vi.useFakeTimers()
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("fatal: Unable to create '/repo/index.lock': File exists"))
      .mockResolvedValueOnce('ok')

    const resultPromise = runWithGitIndexLockRetry(run)
    await vi.advanceTimersByTimeAsync(GIT_INDEX_LOCK_RETRY_DELAYS_MS[0])

    await expect(resultPromise).resolves.toBe('ok')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('rejects without running when the signal is already aborted', async () => {
    vi.useFakeTimers()
    const run = vi.fn<() => Promise<string>>().mockResolvedValue('ok')

    await expect(runWithGitIndexLockRetry(run, AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('cancels a pending retry when the caller aborts', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("fatal: Unable to create '/repo/index.lock': File exists"))

    const resultPromise = runWithGitIndexLockRetry(run, controller.signal)
    await Promise.resolve()
    controller.abort()

    await expect(resultPromise).rejects.toMatchObject({ name: 'AbortError' })
    expect(run).toHaveBeenCalledTimes(1)
  })
})
