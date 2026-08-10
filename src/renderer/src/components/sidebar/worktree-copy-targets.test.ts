import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import { getWorktreeCopyTargets } from './worktree-copy-targets'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/wt',
    repoId: 'repo-1',
    path: '/repo/wt',
    displayName: 'wt',
    branch: 'feature/copy-menu',
    head: 'abc1234',
    ...overrides
  } as Worktree
}

describe('getWorktreeCopyTargets', () => {
  it('copies the worktree path verbatim so Windows and SSH paths survive', () => {
    const targets = getWorktreeCopyTargets({
      worktree: makeWorktree({ path: 'C:\\repos\\orca\\wt' })
    })

    expect(targets.path).toBe('C:\\repos\\orca\\wt')
  })

  it('strips refs/heads/ from the derived branch name', () => {
    const targets = getWorktreeCopyTargets({
      worktree: makeWorktree({ branch: 'refs/heads/feature/x' })
    })

    expect(targets.branchName).toBe('feature/x')
  })

  it('has no branch name on a detached HEAD', () => {
    const targets = getWorktreeCopyTargets({
      worktree: makeWorktree({ branch: '', head: 'deadbee1234' })
    })

    expect(targets.branchName).toBeNull()
  })

  it('prefers the branch name the owning card already resolved', () => {
    const targets = getWorktreeCopyTargets({
      worktree: makeWorktree({ branch: 'refs/heads/stale' }),
      branchName: 'feature/from-card'
    })

    expect(targets.branchName).toBe('feature/from-card')
  })

  it('falls back to the worktree when the owner passes an empty branch', () => {
    const targets = getWorktreeCopyTargets({
      worktree: makeWorktree({ branch: 'feature/copy-menu' }),
      branchName: ''
    })

    expect(targets.branchName).toBe('feature/copy-menu')
  })

  it('labels GitLab reviews MR and exposes the resolved URL', () => {
    const targets = getWorktreeCopyTargets({
      worktree: makeWorktree(),
      review: {
        provider: 'gitlab',
        number: 7,
        title: 'MR',
        url: 'https://gitlab.com/group/proj/-/merge_requests/7'
      }
    })

    expect(targets.reviewLabel).toBe('MR')
    expect(targets.reviewUrl).toBe('https://gitlab.com/group/proj/-/merge_requests/7')
  })

  it.each([
    ['github', 'https://github.com/o/r/pull/1'],
    ['bitbucket', 'https://bitbucket.org/o/r/pull-requests/1'],
    ['azure-devops', 'https://dev.azure.com/o/p/_git/r/pullrequest/1'],
    ['gitea', 'https://gitea.example.com/o/r/pulls/1']
  ] as const)('labels %s reviews PR', (provider, url) => {
    const targets = getWorktreeCopyTargets({
      worktree: makeWorktree(),
      review: { provider, number: 1, title: 'review', url }
    })

    expect(targets.reviewLabel).toBe('PR')
    expect(targets.reviewUrl).toBe(url)
  })

  it('uses a branch-lookup review the card resolved even without linked metadata', () => {
    const targets = getWorktreeCopyTargets({
      worktree: makeWorktree({ linkedPR: null }),
      review: {
        provider: 'github',
        number: 42,
        title: 'External PR',
        url: 'https://github.com/o/r/pull/42'
      }
    })

    expect(targets.reviewUrl).toBe('https://github.com/o/r/pull/42')
  })

  it('trusts an explicit null review over stale linked metadata', () => {
    const targets = getWorktreeCopyTargets({
      worktree: makeWorktree({ linkedPR: 6167 }),
      review: null
    })

    expect(targets.reviewUrl).toBeNull()
    expect(targets.reviewLabel).toBe('PR')
  })

  it('derives the label from linked metadata when no owner resolved a review', () => {
    const targets = getWorktreeCopyTargets({
      worktree: makeWorktree({ linkedGitLabMR: 12 })
    })

    expect(targets.reviewLabel).toBe('MR')
    // Cold cache carries no web URL, so the menu item stays disabled instead of copying a guess.
    expect(targets.reviewUrl).toBeNull()
  })

  it('reports no review for a folder workspace with no links', () => {
    const targets = getWorktreeCopyTargets({
      worktree: makeWorktree({ branch: '', head: '', linkedPR: null })
    })

    expect(targets.branchName).toBeNull()
    expect(targets.reviewUrl).toBeNull()
    expect(targets.reviewLabel).toBe('PR')
  })
})
