import { describe, expect, it } from 'vitest'
import { annotateBranchSwitchCandidates } from './branch-switch-candidates'
import type { Worktree } from '../../../../shared/types'

function wt(id: string, branch: string): Worktree {
  return { id, displayName: id, branch } as unknown as Worktree
}

describe('annotateBranchSwitchCandidates', () => {
  it('flags current, splits local vs remote, and detects checked-out-elsewhere', () => {
    const result = annotateBranchSwitchCandidates({
      refs: [
        { refName: 'feature/login', localBranchName: 'feature/login' },
        { refName: 'main', localBranchName: 'main' },
        { refName: 'hotfix', localBranchName: 'hotfix' },
        { refName: 'origin/teammate', localBranchName: 'teammate' }
      ],
      worktrees: [wt('active', 'feature/login'), wt('hotfix-ws', 'hotfix')],
      activeWorktreeId: 'active',
      activeBranchName: 'feature/login'
    })

    const byName = Object.fromEntries(result.map((c) => [c.branchName, c]))
    expect(byName['feature/login'].isCurrent).toBe(true)
    expect(byName['main'].kind).toBe('local')
    expect(byName['teammate'].kind).toBe('remote')
    expect(byName['hotfix'].checkedOutInWorktreeId).toBe('hotfix-ws')
    expect(byName['hotfix'].checkedOutInWorktreeName).toBe('hotfix-ws')
    expect(byName['main'].checkedOutInWorktreeId).toBeNull()
  })

  it('dedupes a remote ref whose local branch already appeared', () => {
    const result = annotateBranchSwitchCandidates({
      refs: [
        { refName: 'teammate', localBranchName: 'teammate' },
        { refName: 'origin/teammate', localBranchName: 'teammate' }
      ],
      worktrees: [],
      activeWorktreeId: null,
      activeBranchName: 'main'
    })
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('local')
  })
})
