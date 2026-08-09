import { describe, expect, it } from 'vitest'
import { getDeleteWorktreeToastCopy } from './delete-worktree-toast'
import { classifyWorktreeForceDeleteReason } from '../../../../shared/worktree-removal'

// Why: production never hands this function a literal reason — the store derives it from
// classifyWorktreeForceDeleteReason (store/slices/worktrees.ts). Passing one in would let a
// message the classifier rejects still render the force copy, testing a UI that never runs.
function toastCopyForRemovalError(worktreeName: string, error: string): unknown {
  return getDeleteWorktreeToastCopy(worktreeName, classifyWorktreeForceDeleteReason(error), error)
}

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
      toastCopyForRemovalError(
        'feature/foo',
        'Failed to physically stop every PTY for worktree: repo-1::/w — could not verify these exited: term_a (the process list timed out)'
      )
    ).toEqual({
      title: 'Failed to delete workspace feature/foo',
      description:
        'Orca could not confirm every terminal in this workspace has exited, so it stopped before deleting any files. Use Force Delete to remove it anyway.',
      isDestructive: false
    })
  })

  // Why: Force Delete proceeds on a proven-live PTY too, so the copy must not describe
  // that as an unconfirmed exit — the user is killing a terminal Orca watched running.
  it('names the running terminals when verification proved they are still live', () => {
    expect(
      toastCopyForRemovalError(
        'feature/foo',
        'Failed to physically stop every PTY for worktree: repo-1::/w — still live: term_a'
      )
    ).toEqual({
      title: 'Failed to delete workspace feature/foo',
      description:
        'This workspace still has running terminals, so Orca stopped before deleting any files. Force Delete will kill them and discard any uncommitted work they hold.',
      isDestructive: false
    })
  })

  // Why: a sweep that never answered wedges removal the same way, and the waiver clears
  // both — so it must reach the same force affordance instead of a dead end.
  it('offers force delete when the teardown sweep itself timed out', () => {
    expect(
      toastCopyForRemovalError(
        'feature/foo',
        'Timed out waiting for physical PTY teardown: repo-1::/w. Retry with force delete (--force) to remove it anyway.'
      )
    ).toEqual({
      title: 'Failed to delete workspace feature/foo',
      description:
        'Orca could not confirm every terminal in this workspace has exited, so it stopped before deleting any files. Use Force Delete to remove it anyway.',
      isDestructive: false
    })
  })

  // Why: the same wedge worded by the provider instead of the deadline — a dropped SSH
  // channel — must reach the same offer, or the escape hatch misses the case it was for.
  it('offers force delete when the sweep failed rather than timed out', () => {
    expect(
      toastCopyForRemovalError(
        'feature/foo',
        'Failed to physically stop every PTY for worktree: repo-1::/w — the terminal sweep failed: SSH channel closed while listing processes. Retry with force delete (--force) to remove it anyway.'
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
