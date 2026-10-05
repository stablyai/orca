import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../shared/worktree/types'
import { buildRows } from './worktree-list/grouping/build-rows'

const STATUSES: WorkspaceStatusDefinition[] = [
  { id: 'todo', label: 'To do' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'completed', label: 'Done' }
]

function buildLargeInventory(projectCount: number, worktreesPerProject: number) {
  const repos = new Map<string, Repo>()
  const worktrees: Worktree[] = []
  for (let projectIndex = 0; projectIndex < projectCount; projectIndex += 1) {
    const repo: Repo = {
      id: `repo-${projectIndex}`,
      path: `/tmp/project-${projectIndex}`,
      displayName: `project-${projectIndex}`,
      badgeColor: '#000000',
      addedAt: projectIndex
    }
    repos.set(repo.id, repo)
    for (let worktreeIndex = 0; worktreeIndex < worktreesPerProject; worktreeIndex += 1) {
      worktrees.push({
        id: `wt-${projectIndex}-${worktreeIndex}`,
        repoId: repo.id,
        path: `/tmp/project-${projectIndex}/worktree-${worktreeIndex}`,
        branch: `refs/heads/feature-${worktreeIndex}`,
        head: `${projectIndex}-${worktreeIndex}`,
        isBare: false,
        isMainWorktree: false,
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        comment: '',
        isUnread: false,
        isPinned: false,
        displayName: `feature-${worktreeIndex}`,
        sortOrder: worktreeIndex,
        lastActivityAt: worktreeIndex,
        workspaceStatus: STATUSES[worktreeIndex % STATUSES.length].id
      })
    }
  }
  return { repos, worktrees }
}

function buildProjectStatusRows(
  worktrees: Worktree[],
  repos: Map<string, Repo>,
  statuses: readonly WorkspaceStatusDefinition[] = STATUSES,
  emptySecondaryStatusSourceGroupKey: string | null = null
) {
  return buildRows(
    'repo',
    worktrees,
    repos,
    null,
    new Set(),
    undefined,
    statuses,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    [],
    new Set(),
    new Map(),
    new Map(),
    [],
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    {
      secondary: 'workspace-status',
      emptySecondaryStatusSourceGroupKey
    }
  )
}

describe('two-level grouping at scale', () => {
  it('builds one Project and three Status headers per 1,000-worktree inventory', () => {
    const { repos, worktrees } = buildLargeInventory(200, 5)
    const rows = buildProjectStatusRows(worktrees, repos)
    const headers = rows.filter((row) => row.type === 'header')
    const items = rows.filter((row) => row.type === 'item')

    expect(items).toHaveLength(1_000)
    expect(headers).toHaveLength(800)
    expect(new Set(headers.map((row) => row.key)).size).toBe(800)
    expect(rows).toHaveLength(1_800)
  })

  it('adds empty drag targets only to the active Project at scale', () => {
    const { repos, worktrees } = buildLargeInventory(200, 5)
    const sourceKey = 'repo:repo-99/workspace-status:todo'
    const rows = buildProjectStatusRows(
      worktrees,
      repos,
      [...STATUSES, { id: 'blocked', label: 'Blocked' }],
      sourceKey
    )
    const emptyHeaders = rows.filter(
      (row) => row.type === 'header' && row.groupKind === 'workspace-status' && row.count === 0
    )

    expect(emptyHeaders).toMatchObject([{ key: 'repo:repo-99/workspace-status:blocked', count: 0 }])
  })
})
