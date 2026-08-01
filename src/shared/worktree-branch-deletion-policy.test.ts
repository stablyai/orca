import { describe, expect, it } from 'vitest'
import { resolveWorktreeBranchRetention } from './worktree-branch-deletion-policy'

describe('resolveWorktreeBranchRetention', () => {
  it('deletes the branch for a worktree without metadata', () => {
    expect(resolveWorktreeBranchRetention(undefined, 'refs/heads/feature/x')).toBe('delete')
    expect(resolveWorktreeBranchRetention(null, 'feature/x')).toBe('delete')
  })

  it('reports a pre-existing branch checkout Orca never owned', () => {
    expect(
      resolveWorktreeBranchRetention(
        { preserveBranchOnDelete: true, createdBranch: 'feature/x' },
        'refs/heads/feature/x'
      )
    ).toBe('preexisting-branch')
  })

  it('deletes the branch while the checkout still matches the created branch', () => {
    expect(
      resolveWorktreeBranchRetention({ createdBranch: 'feature/x' }, 'refs/heads/feature/x')
    ).toBe('delete')
    expect(
      resolveWorktreeBranchRetention({ createdBranch: 'refs/heads/feature/x' }, 'feature/x')
    ).toBe('delete')
  })

  it('reports drift when the checkout moved off the created branch', () => {
    // The reported bug: an agent ran `git checkout main && git merge` inside the worktree.
    expect(resolveWorktreeBranchRetention({ createdBranch: 'feature/x' }, 'refs/heads/main')).toBe(
      'checkout-drift'
    )
  })

  it('deletes the branch when either side of the comparison is unknown', () => {
    // Detached HEAD reports no branch; legacy metadata predates createdBranch.
    expect(resolveWorktreeBranchRetention({ createdBranch: 'feature/x' }, '')).toBe('delete')
    expect(resolveWorktreeBranchRetention({}, 'refs/heads/feature/x')).toBe('delete')
  })
})
