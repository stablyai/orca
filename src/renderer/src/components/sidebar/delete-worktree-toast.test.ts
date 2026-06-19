import { describe, expect, it } from 'vitest'
import { getDeleteWorktreeToastCopy } from './delete-worktree-toast'

describe('getDeleteWorktreeToastCopy', () => {
  it('uses direct guidance when force delete is available', () => {
    expect(getDeleteWorktreeToastCopy('feature/foo', true, 'branch has changes')).toEqual({
      title: 'Failed to delete workspace feature/foo',
      description: 'It has changed files. Use Force Delete to delete it anyway.',
      isDestructive: false
    })
  })

  it('uses orphaned-directory guidance when Git tracking is already gone', () => {
    expect(
      getDeleteWorktreeToastCopy(
        'feature/foo',
        true,
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
        true,
        'Worktree is no longer registered with Git and its directory is already gone.'
      )
    ).toEqual({
      title: 'Failed to delete workspace feature/foo',
      description: 'Git already removed this workspace. Use Force Delete to clear it from Orca.',
      isDestructive: false
    })
  })

  it('preserves the raw error when force delete is unavailable', () => {
    expect(getDeleteWorktreeToastCopy('feature/foo', false, 'permission denied')).toEqual({
      title: 'Failed to delete workspace feature/foo',
      description: 'permission denied',
      isDestructive: true
    })
  })
})
