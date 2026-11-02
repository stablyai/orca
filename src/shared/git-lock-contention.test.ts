import { describe, expect, it } from 'vitest'
import { isGitLockContentionFailure } from './git-lock-contention'

describe('isGitLockContentionFailure', () => {
  it.each([
    "fatal: Unable to create '/repo/.git/index.lock': File exists.",
    "fatal: Unable to create 'C:/repo/.git/worktrees/wt/index.lock': File exists.",
    "fatal: cannot lock ref 'refs/heads/main': Unable to create '/repo/.git/refs/heads/main.lock': File exists.",
    "error: Unable to create '/repo/.git/packed-refs.lock': File exists.",
    'error: could not lock config file .git/config: File exists'
  ])('matches %s', (stderr) => {
    expect(isGitLockContentionFailure(Object.assign(new Error('Command failed'), { stderr }))).toBe(
      true
    )
  })

  it.each([
    "fatal: cannot lock ref 'refs/heads/main': is at abc but expected def",
    'fatal: ambiguous argument',
    'error: Your local changes to the following files would be overwritten by checkout'
  ])('does not match %s', (message) => {
    expect(isGitLockContentionFailure(new Error(message))).toBe(false)
  })

  it('reads the relay error message, which carries git stderr', () => {
    expect(
      isGitLockContentionFailure(
        new Error(
          "Command failed: git reset --hard abc\nfatal: Unable to create '/r/.git/index.lock': File exists."
        )
      )
    ).toBe(true)
  })
})
