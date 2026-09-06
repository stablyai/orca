import { describe, expect, it } from 'vitest'
import {
  createWorktreePreparationLockReason,
  isWorktreeCreatePreparation,
  parseWorktreePreparationPathOwnerPid,
  WORKTREE_CREATE_PREPARATION_DIRECTORY
} from './create-preparation'

describe('worktree create preparation classification', () => {
  it('recognizes an explicitly locked preparation regardless of branch state', () => {
    expect(
      isWorktreeCreatePreparation({
        path: `/workspace/${WORKTREE_CREATE_PREPARATION_DIRECTORY}/123-checkout`,
        branch: 'refs/heads/feature',
        lockReason: createWorktreePreparationLockReason('test')
      })
    ).toBe(true)
  })

  it('does not classify a branch-attached user worktree by path alone', () => {
    expect(
      isWorktreeCreatePreparation({
        path: `/workspace/${WORKTREE_CREATE_PREPARATION_DIRECTORY}/123-user-worktree`,
        branch: 'refs/heads/feature',
        lockReason: undefined
      })
    ).toBe(false)
  })

  it('does not classify an unlocked detached path without durable ownership', () => {
    expect(
      isWorktreeCreatePreparation({
        path: `/workspace/${WORKTREE_CREATE_PREPARATION_DIRECTORY}/123-checkout`,
        branch: undefined,
        lockReason: undefined
      })
    ).toBe(false)
  })

  it('does not parse an arbitrary preparation path with a numeric prefix', () => {
    expect(
      parseWorktreePreparationPathOwnerPid(
        `/workspace/${WORKTREE_CREATE_PREPARATION_DIRECTORY}/123-checkout`
      )
    ).toBeNull()
  })

  it('does not classify an arbitrary detached user path by directory name alone', () => {
    expect(
      isWorktreeCreatePreparation({
        path: `/workspace/${WORKTREE_CREATE_PREPARATION_DIRECTORY}/user-worktree`,
        branch: undefined,
        lockReason: undefined
      })
    ).toBe(false)
  })
})
