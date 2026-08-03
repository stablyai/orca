import { describe, expect, it } from 'vitest'
import { getDeleteWorktreeToastCopy } from './delete-worktree-toast'

describe('getDeleteWorktreeToastCopy', () => {
  it('uses direct guidance when force delete is available', () => {
    expect(getDeleteWorktreeToastCopy('feature/foo', 'dirty', 'branch has changes')).toEqual({
      title: 'Failed to delete workspace feature/foo',
      description: 'It has changed files. Use Force Delete to delete it anyway.',
      isDestructive: false
    })
  })

  // Why (#11960): the PTY gate's error tells the user to force-delete, so the
  // toast has to actually offer it — a reason of null hides the button entirely.
  it('uses terminal-teardown guidance when a PTY stop could not be proven', () => {
    expect(
      getDeleteWorktreeToastCopy(
        'feature/foo',
        'unstopped-pty',
        'Failed to physically stop every PTY for worktree: repo-1::/w — still live: term_a'
      )
    ).toEqual({
      title: 'Failed to delete workspace feature/foo',
      description:
        'Orca could not confirm every terminal in this workspace has exited, so it stopped before deleting any files. Use Force Delete to remove it anyway.',
      isDestructive: false
    })
  })

  it('uses orphaned-directory guidance when Git tracking is already gone', () => {
    expect(
      getDeleteWorktreeToastCopy(
        'feature/foo',
        'orphan-directory',
        'Worktree is no longer registered with Git but its directory remains.'
      )
    ).toEqual({
      title: 'Failed to delete workspace feature/foo',
      description:
        'Git already forgot this workspace, but its directory is still on disk. Use Force Delete to remove the orphaned directory.',
      isDestructive: false
    })
  })

  it('uses stale-row guidance when Git already removed the worktree directory', () => {
    expect(
      getDeleteWorktreeToastCopy(
        'feature/foo',
        'missing-registration',
        'Worktree is no longer registered with Git and its directory is already gone.'
      )
    ).toEqual({
      title: 'Failed to delete workspace feature/foo',
      description: 'Git already removed this workspace. Use Force Delete to clear it from Orca.',
      isDestructive: false
    })
  })

  it('preserves the raw error when force delete is unavailable', () => {
    expect(getDeleteWorktreeToastCopy('feature/foo', null, 'permission denied')).toEqual({
      title: 'Failed to delete workspace feature/foo',
      description: 'permission denied',
      isDestructive: true
    })
  })

  it('uses lock-specific guidance', () => {
    expect(getDeleteWorktreeToastCopy('feature/foo', null, 'Worktree is locked by Git.')).toEqual({
      title: 'Failed to delete workspace feature/foo',
      description:
        'This workspace is locked by Git. Run git worktree unlock <worktree-path> from its repository, then retry deletion.',
      isDestructive: false
    })
  })

  it('includes the structured Git lock reason in localized recovery copy', () => {
    expect(
      getDeleteWorktreeToastCopy(
        'feature/foo',
        null,
        'Worktree is locked by Git. Lock reason: active agent session.',
        'active agent session'
      )
    ).toEqual({
      title: 'Failed to delete workspace feature/foo',
      description:
        'This workspace is locked by Git. Git reported: active agent session. Run git worktree unlock <worktree-path> from its repository, then retry deletion.',
      isDestructive: false
    })
  })
})
