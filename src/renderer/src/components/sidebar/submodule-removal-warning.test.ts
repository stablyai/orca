import { describe, expect, it } from 'vitest'
import { classifyWorktreeForceDeleteReason } from '../../../../shared/worktree/removal'
import { getDeleteWorktreeToastCopy } from './delete-worktree-toast'
import { getWorktreeDeleteErrorToShow } from './worktree-delete-error-display'

const refusal = 'fatal: working trees containing submodules cannot be moved or removed'

describe('submodule removal guidance', () => {
  it('warns about files and unpublished commits in both toast and dialog', () => {
    const copy = getDeleteWorktreeToastCopy(
      'feature/submodules',
      classifyWorktreeForceDeleteReason(refusal),
      refusal
    )
    expect(copy.description).toContain('unpublished commits')
    expect(copy.description).toContain('permanently discard')
    expect(getWorktreeDeleteErrorToShow(null, { isDeleting: false, error: refusal })).toBe(
      copy.description
    )
    expect(
      getWorktreeDeleteErrorToShow({ removalError: refusal }, { isDeleting: false, error: null })
    ).toBe(copy.description)
  })

  it('preserves unrelated errors', () => {
    expect(
      getWorktreeDeleteErrorToShow(null, { isDeleting: false, error: 'permission denied' })
    ).toBe('permission denied')
  })
})
