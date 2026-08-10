import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GIT_WORKTREE_CREATE_CLEANUP_TIMEOUT_MS,
  GIT_WORKTREE_CREATE_TIMEOUT_MAX_MS,
  GIT_WORKTREE_CREATE_TIMEOUT_MS,
  clampGitWorktreeCreateTimeoutMs,
  createGitWorktreeCleanupDeadline,
  createGitWorktreeDeadline,
  gitWorktreeCreateTransportTimeoutMs,
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

  it('preserves a remaining transport budget below the configurable minimum', () => {
    expect(clampGitWorktreeCreateTimeoutMs(250)).toBe(250)
  })

  it('starts cleanup with a fresh reserve after the operation deadline expired', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValue(2_000)
    const operation = createGitWorktreeDeadline(500)

    expect(() => remainingGitWorktreeCreateMs(operation, 'late child')).toThrow(
      'timed out during late child'
    )
    const cleanup = createGitWorktreeCleanupDeadline()
    expect(remainingGitWorktreeCreateMs(cleanup, 'rollback')).toBe(
      GIT_WORKTREE_CREATE_CLEANUP_TIMEOUT_MS
    )
  })

  it('keeps the transport alive through operation cleanup and response publication', () => {
    expect(gitWorktreeCreateTransportTimeoutMs(600_000)).toBe(635_000)
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
