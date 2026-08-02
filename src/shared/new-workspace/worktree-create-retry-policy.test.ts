import { describe, expect, it } from 'vitest'
import {
  getClientWorktreeCreateCandidate,
  isRetryableWorktreeCreateConflict
} from './worktree-create-retry-policy'

describe('client worktree create retry policy', () => {
  it('uses the same suffix sequence for every client', () => {
    expect(getClientWorktreeCreateCandidate('feature', 0)).toBe('feature')
    expect(getClientWorktreeCreateCandidate('feature', 1)).toBe('feature-2')
  })

  it('retries only known branch and review conflicts', () => {
    expect(isRetryableWorktreeCreateConflict('Branch already exists locally')).toBe(true)
    expect(isRetryableWorktreeCreateConflict('Branch "x" already exists.')).toBe(true)
    expect(isRetryableWorktreeCreateConflict('Branch already has PR #42')).toBe(true)
    expect(isRetryableWorktreeCreateConflict('Permission denied')).toBe(false)
  })
})
