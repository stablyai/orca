import { describe, expect, it } from 'vitest'
import { formatForkCreatedAt, getForkLabel } from './WorktreeForkManagementDialog'
import type { Worktree } from '../../../../shared/types'

function makeWorktree(overrides: Partial<Worktree>): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/repo/wt-1',
    branch: 'feature',
    displayName: '',
    head: null,
    isBare: false,
    isMainWorktree: false,
    ...overrides
  } as Worktree
}

describe('WorktreeForkManagementDialog labels', () => {
  it('prefers display name, then branch, then path, then id for fork labels', () => {
    expect(getForkLabel(makeWorktree({ displayName: 'Readable' }))).toBe('Readable')
    expect(getForkLabel(makeWorktree({ displayName: '', branch: 'feature/a' }))).toBe('feature/a')
    expect(getForkLabel(makeWorktree({ displayName: '', branch: '', path: '/tmp/fork' }))).toBe(
      '/tmp/fork'
    )
    expect(getForkLabel(makeWorktree({ displayName: '', branch: '', path: '' }))).toBe('wt-1')
  })

  it('shows unknown for invalid fork creation timestamps', () => {
    expect(formatForkCreatedAt(0)).toBe('Unknown')
    expect(formatForkCreatedAt(Number.NaN)).toBe('Unknown')
  })
})
