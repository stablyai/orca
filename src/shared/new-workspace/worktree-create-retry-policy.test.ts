import { describe, expect, it } from 'vitest'
import {
  getGeneratedWorktreeCreateRetryCandidate,
  isRetryableWorktreeCreateConflict
} from './worktree-create-retry-policy'

describe('client worktree create retry policy', () => {
  it('keeps generated retries on canonical tiers', () => {
    expect(getGeneratedWorktreeCreateRetryCandidate('nautilus-2', 0)).toBe('nautilus-2')
    expect(getGeneratedWorktreeCreateRetryCandidate('nautilus-2', 1)).toBe('nautilus-3')
    expect(getGeneratedWorktreeCreateRetryCandidate('nautilus-2-3', 0)).toBe('nautilus-4')
  })

  it('retries only known branch and review conflicts', () => {
    expect(isRetryableWorktreeCreateConflict('Branch already exists locally')).toBe(true)
    expect(isRetryableWorktreeCreateConflict('Branch "x" already exists.')).toBe(true)
    expect(isRetryableWorktreeCreateConflict('Branch already has PR #42')).toBe(true)
    expect(isRetryableWorktreeCreateConflict('Permission denied')).toBe(false)
  })
})
