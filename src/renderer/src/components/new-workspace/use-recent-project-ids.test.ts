import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { orderProjectIdsByRecency } from './use-recent-project-ids'

function worktree(partial: Partial<Worktree>): Worktree {
  return {
    id: `${partial.repoId ?? 'repo'}::${partial.path ?? '/tmp/wt'}`,
    repoId: partial.repoId ?? 'repo',
    displayName: 'wt',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    path: '/tmp/wt',
    branch: 'main',
    ...partial
  } as Worktree
}

describe('orderProjectIdsByRecency', () => {
  it('uses the newest workspace per project, not the oldest', () => {
    const ids = orderProjectIdsByRecency([
      worktree({ projectId: 'alpha', createdAt: 1 }),
      worktree({ projectId: 'alpha', createdAt: 99 }),
      worktree({ projectId: 'beta', createdAt: 50 })
    ])
    expect(ids[0]).toBe('alpha')
  })

  it('skips legacy repo-only workspaces that carry no project identity', () => {
    const ids = orderProjectIdsByRecency([
      worktree({ projectId: undefined, createdAt: 99 }),
      worktree({ projectId: 'beta', createdAt: 1 })
    ])
    expect(ids).toContain('beta')
    expect(ids).not.toContain(undefined)
  })
})
