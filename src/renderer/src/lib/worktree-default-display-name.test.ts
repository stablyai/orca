import { describe, expect, it } from 'vitest'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from './worktree-default-display-name'

describe('resolveWorktreeBranchLabel', () => {
  it('returns empty instead of throwing when branch is absent at runtime', () => {
    // Empty-query rows reach render before branch search; branchName() must tolerate missing branches there too.
    expect(resolveWorktreeBranchLabel({ branch: undefined as unknown as string })).toBe('')
  })
})

describe('resolveWorktreeDisplayName', () => {
  it('falls back to the branch when a cleared name left the field undefined', () => {
    expect(
      resolveWorktreeDisplayName({
        displayName: undefined as unknown as string,
        branch: 'refs/heads/main',
        path: '/repos/orca'
      })
    ).toBe('main')
  })

  it('falls back to the folder name for a branch-less folder workspace', () => {
    expect(
      resolveWorktreeDisplayName({ displayName: '', branch: '', path: '/repos/design-review' })
    ).toBe('design-review')
  })

  it('resolves the folder name from a Windows path', () => {
    expect(
      resolveWorktreeDisplayName({
        displayName: '',
        branch: '',
        path: 'C:\\Users\\alice\\repos\\design-review'
      })
    ).toBe('design-review')
  })

  it('returns empty rather than throwing when every source is missing', () => {
    expect(
      resolveWorktreeDisplayName({
        displayName: undefined as unknown as string,
        branch: undefined as unknown as string,
        path: undefined as unknown as string
      })
    ).toBe('')
  })
})
