import { describe, expect, it } from 'vitest'
import { getDeleteWorktreeToastCopy } from './delete-worktree-toast'

describe('getDeleteWorktreeToastCopy', () => {
  it('uses direct guidance when force delete is available', () => {
    expect(getDeleteWorktreeToastCopy('feature/foo', true, 'branch has changes')).toEqual({
      title: 'Failed to delete worktree feature/foo',
      description: 'It has changed files. Use Force Delete to delete it anyway.',
      isDestructive: false
    })
  })

  it('preserves the raw error when force delete is unavailable', () => {
    expect(getDeleteWorktreeToastCopy('feature/foo', false, 'permission denied')).toEqual({
      title: 'Failed to delete worktree feature/foo',
      description: 'permission denied',
      isDestructive: true
    })
  })
})
