import { describe, expect, it } from 'vitest'
import {
  classifyWorktreeForceDeleteReason,
  UNPUSHED_SUBMODULE_WORKTREE_REMOVAL_MESSAGE
} from './worktree-removal'

describe('classifyWorktreeForceDeleteReason', () => {
  it('classifies the unpushed-submodule refusal as force-deletable', () => {
    expect(classifyWorktreeForceDeleteReason(UNPUSHED_SUBMODULE_WORKTREE_REMOVAL_MESSAGE)).toBe(
      'unpushed-submodules'
    )
  })

  it('does not offer force for the unpushed-submodule error after a forced attempt', () => {
    expect(
      classifyWorktreeForceDeleteReason(UNPUSHED_SUBMODULE_WORKTREE_REMOVAL_MESSAGE, true)
    ).toBeNull()
  })

  it('keeps lock refusals out of every force path', () => {
    expect(
      classifyWorktreeForceDeleteReason(
        `Worktree is locked by Git. ${UNPUSHED_SUBMODULE_WORKTREE_REMOVAL_MESSAGE}`
      )
    ).toBeNull()
  })

  it('still classifies dirty-tree errors', () => {
    expect(
      classifyWorktreeForceDeleteReason('Worktree has uncommitted or untracked changes.')
    ).toBe('dirty')
  })
})
