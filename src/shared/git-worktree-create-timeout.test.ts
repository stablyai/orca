import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_WORKTREE_CREATE_TIMEOUT_MAX_MS,
  GIT_WORKTREE_CREATE_TIMEOUT_MS,
  createGitWorktreeDeadline,
  remainingGitWorktreeCreateMs,
  resolveGitWorktreeCreateTimeoutMs,
  runWithinGitWorktreeDeadline
} from './git-worktree-create-timeout'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('git worktree create timeout policy', () => {
  it('preserves the configurable slow-checkout range', () => {
    expect(resolveGitWorktreeCreateTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '600000' })).toBe(
      600_000
    )
    expect(resolveGitWorktreeCreateTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: 'Infinity' })).toBe(
      GIT_WORKTREE_CREATE_TIMEOUT_MAX_MS
    )
    expect(resolveGitWorktreeCreateTimeoutMs({ ORCA_WORKTREE_ADD_TIMEOUT_MS: '300' })).toBe(
      GIT_WORKTREE_CREATE_TIMEOUT_MS
    )
  })

  it('derives every child budget from one absolute deadline', () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_100)
      .mockReturnValue(1_250)
    const deadline = createGitWorktreeDeadline(500)

    expect(remainingGitWorktreeCreateMs(deadline, 'first child')).toBe(400)
    expect(remainingGitWorktreeCreateMs(deadline, 'later child')).toBe(250)
  })

  it('bounds a stalled filesystem operation by the same deadline', async () => {
    vi.useFakeTimers()
    const deadline = createGitWorktreeDeadline(25)
    const operation = runWithinGitWorktreeDeadline(
      deadline,
      'filesystem stat',
      () => new Promise<void>(() => {})
    )
    const rejection = expect(operation).rejects.toThrow('timed out during filesystem stat')

    await vi.advanceTimersByTimeAsync(25)
    await rejection
  })
})
