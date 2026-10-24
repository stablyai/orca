import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
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
  it('orders projects by their newest workspace, newest first', () => {
    const ids = orderProjectIdsByRecency([
      worktree({ projectId: 'alpha', createdAt: 10 }),
      worktree({ projectId: 'beta', createdAt: 30 }),
      worktree({ projectId: 'gamma', createdAt: 20 })
    ])
    expect(ids.filter((id) => !id.includes(':'))).toEqual(['beta', 'gamma', 'alpha'])
  })

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

  it('emits the folder-group option id too, so grouped targets resolve', () => {
    const ids = orderProjectIdsByRecency([worktree({ projectId: 'alpha', createdAt: 5 })])
    expect(ids).toContain('project-group:alpha')
  })

  it('treats a missing createdAt as oldest rather than crashing', () => {
    const ids = orderProjectIdsByRecency([
      worktree({ projectId: 'alpha' }),
      worktree({ projectId: 'beta', createdAt: 5 })
    ])
    expect(ids[0]).toBe('beta')
  })
})

it('indexes current workspace ownership linearly at N and 10N and reuses an unchanged catalog', () => {
  const counts = [10, 100].map((count) => {
    let reads = 0
    const repos = Array.from({ length: count }, (_, i) => ({
      id: `checkout-${i}`,
      path: `/checkout/${i}`,
      displayName: `${i}`,
      badgeColor: '',
      addedAt: i
    }))
    const setups = projectHostSetupProjectionFromRepos(repos).setups.map((setup) => ({
      ...setup,
      get repoId() {
        reads++
        return setup.repoId
      }
    }))
    const workspaces = repos.map((repo, i) =>
      worktree({ repoId: repo.id, projectId: 'old-shared-project', createdAt: i })
    )
    const ids = orderProjectIdsByRecency(workspaces, setups)
    expect(ids).toHaveLength(count * 2)
    expect(ids[0]).toBe(`repo:checkout-${count - 1}`)
    const firstReads = reads
    expect(orderProjectIdsByRecency(workspaces, setups)).toEqual(ids)
    expect(reads).toBe(firstReads)
    expect(firstReads).toBeLessThanOrEqual(count * 8)
    return firstReads
  })
  expect(counts[1]).toBeLessThanOrEqual(counts[0] * 10)
})
