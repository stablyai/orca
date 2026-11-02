import { describe, expect, it } from 'vitest'
import { getDeleteWorktreeToastCopy } from './delete-worktree-toast'
import { classifyWorktreeForceDeleteReason } from '../../../../shared/worktree/removal'

// Use the production classifier so tests cannot render force-delete copy for an unreachable reason.
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

  it('offers force delete when an agent session could not be confirmed closed', () => {
    expect(
      toastCopyForRemovalError(
        'feature/foo',
        'Refusing to remove worktree with running agent sessions: repo-1::/w — could not confirm these closed: 1 agent session (claude). Retry with force delete (--force) to remove it anyway.'
      )
    ).toEqual({
      title: 'Failed to delete workspace feature/foo',
      description:
        'Orca could not confirm every agent session in this workspace has closed, so it stopped before deleting any files. Use Force Delete to remove it anyway.',
      isDestructive: false
    })
  })

  it('names the running agent sessions when the close left them attached', () => {
    expect(
      toastCopyForRemovalError(
        'feature/foo',
        'Refusing to remove worktree with running agent sessions: repo-1::/w — still live: 2 agent sessions (claude, codex). Retry with force delete (--force) to remove it anyway.'
      )
    ).toEqual({
      title: 'Failed to delete workspace feature/foo',
      description:
        'This workspace still has running agent sessions that Orca could not close, so it stopped before deleting any files. Force Delete will discard any work they hold.',
      isDestructive: false
    })
  })

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
