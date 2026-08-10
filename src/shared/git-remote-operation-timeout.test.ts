import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_REMOTE_OPERATION_CLEANUP_RESERVE_MS,
  GIT_REMOTE_OPERATION_TIMEOUT_MS,
  createGitRemoteOperationDeadline,
  gitRemoteOperationExecutionTimeoutMs,
  gitRemoteOperationRemainingMs,
  resolveGitRemoteOperationTimeoutMs,
  runWithGitRemoteOperationDeadline
} from './git-remote-operation-timeout'

afterEach(() => vi.useRealTimers())

describe('Git remote operation deadline', () => {
  it('accepts bounded positive overrides and rejects invalid policy values', () => {
    expect(resolveGitRemoteOperationTimeoutMs('3000')).toBe(3_000)
    expect(resolveGitRemoteOperationTimeoutMs('0')).toBe(GIT_REMOTE_OPERATION_TIMEOUT_MS)
    expect(resolveGitRemoteOperationTimeoutMs('120001')).toBe(GIT_REMOTE_OPERATION_TIMEOUT_MS)
    expect(resolveGitRemoteOperationTimeoutMs('not-a-number')).toBe(GIT_REMOTE_OPERATION_TIMEOUT_MS)
  })

  it('derives remaining transport and cleanup-reserved execution budgets', () => {
    const deadline = createGitRemoteOperationDeadline(10_000, 1_000)

    expect(gitRemoteOperationRemainingMs(deadline, 2_000)).toBe(9_000)
    expect(gitRemoteOperationExecutionTimeoutMs(deadline, 2_000)).toBe(
      9_000 - GIT_REMOTE_OPERATION_CLEANUP_RESERVE_MS
    )
  })

  it('aborts the shared signal at the absolute deadline', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const operation = runWithGitRemoteOperationDeadline(100, async (context) => {
      signal = context.signal
      return new Promise<never>(() => {})
    })
    const rejection = expect(operation).rejects.toThrow('git timed out.')

    await vi.advanceTimersByTimeAsync(100)

    await rejection
    expect(signal?.aborted).toBe(true)
  })

  it('does not start work after caller cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = vi.fn(async () => 'unexpected')

    await expect(
      runWithGitRemoteOperationDeadline(100, run, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(run).not.toHaveBeenCalled()
  })
})
