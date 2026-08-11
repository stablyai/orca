import { describe, expect, it } from 'vitest'
import { isSubmoduleWorktreeRemovalRefusal } from './worktree-submodule-removal'

describe('isSubmoduleWorktreeRemovalRefusal', () => {
  it('matches the English git fatal on stderr', () => {
    expect(
      isSubmoduleWorktreeRemovalRefusal(
        Object.assign(new Error('git worktree remove failed'), {
          stderr: 'fatal: working trees containing submodules cannot be moved or removed\n'
        })
      )
    ).toBe(true)
  })

  it('matches when the refusal is only in the error message', () => {
    expect(
      isSubmoduleWorktreeRemovalRefusal(
        new Error('fatal: working trees containing submodules cannot be moved or removed')
      )
    ).toBe(true)
  })

  it('does not match dirty-worktree or lock refusals', () => {
    expect(
      isSubmoduleWorktreeRemovalRefusal(
        Object.assign(new Error('git worktree remove failed'), {
          stderr: 'fatal: contains modified or untracked files, use --force to delete it'
        })
      )
    ).toBe(false)
    expect(
      isSubmoduleWorktreeRemovalRefusal(
        Object.assign(new Error('git worktree remove failed'), {
          stderr: 'fatal: cannot remove a locked working tree'
        })
      )
    ).toBe(false)
  })
})
