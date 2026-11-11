import { describe, expect, it } from 'vitest'
import { isGitLockContentionFailure } from './git-lock-contention'

describe('isGitLockContentionFailure', () => {
  it.each([
    "fatal: cannot lock ref 'refs/heads/main': is at abc but expected def",
    'fatal: ambiguous argument',
    'error: Your local changes to the following files would be overwritten by checkout'
  ])('does not match %s', (message) => {
    expect(isGitLockContentionFailure(new Error(message))).toBe(false)
  })
})
