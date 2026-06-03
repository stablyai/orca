import { describe, expect, it } from 'vitest'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

describe('toRuntimeWorktreeSelector', () => {
  it('addresses raw worktree IDs as runtime ID selectors', () => {
    expect(toRuntimeWorktreeSelector('wt-1')).toBe('id:wt-1')
    expect(toRuntimeWorktreeSelector('repo-1::C:/Users/me/orca/workspaces/orca/new-worktree')).toBe(
      'id:repo-1::C:/Users/me/orca/workspaces/orca/new-worktree'
    )
  })

  it('preserves existing ID selectors and empty values', () => {
    expect(toRuntimeWorktreeSelector('id:wt-1')).toBe('id:wt-1')
    expect(toRuntimeWorktreeSelector('')).toBe('')
  })
})
