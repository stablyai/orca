import { describe, expect, it } from 'vitest'
import { getCreationWorktreeMeta } from './worktree-creation-meta'

describe('getCreationWorktreeMeta', () => {
  it('writes the trimmed note and normalized tags', () => {
    expect(
      getCreationWorktreeMeta('  fix login  ', ['billing team', 'Billing Team', 'api'])
    ).toEqual({ comment: 'fix login', tags: ['billing team', 'api'] })
  })

  it('is empty when there is nothing to save', () => {
    expect(getCreationWorktreeMeta('   ', [])).toEqual({})
    expect(getCreationWorktreeMeta(undefined, undefined)).toEqual({})
  })
})
