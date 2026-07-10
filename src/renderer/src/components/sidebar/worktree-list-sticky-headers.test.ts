import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list-groups'
import { getStickyHeaderIndexes } from './worktree-list-virtual-rows'
import type { ProjectGroup, Repo, Worktree } from '../../../../shared/types'
import type { Row } from './worktree-list-groups'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: '#000',
  addedAt: 1
}

const makeHeaderRow = (
  key: string,
  overrides: Partial<Extract<Row, { type: 'header' }>> = {}
): Extract<Row, { type: 'header' }> => ({
  type: 'header',
  key,
  label: key,
  count: 0,
  tone: 'text-foreground',
  ...overrides
})

const makeWorktree = (id: string): Worktree => ({
  id,
  repoId: repo.id,
  path: `/repo/${id}`,
  head: 'abc123',
  branch: `refs/heads/${id}`,
  isBare: false,
  isMainWorktree: false,
  displayName: id,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  linkedGitLabMR: null,
  linkedGitLabIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
})

const makeWorktreeRow = (id: string): Extract<Row, { type: 'item' }> => ({
  type: 'item',
  rowKey: `all:${id}`,
  sectionKey: 'all',
  worktree: makeWorktree(id),
  repo,
  depth: 0,
  groupDepth: 0,
  lineageTrail: [],
  isLastLineageChild: false,
  lineageChildCount: 0
})

describe('getStickyHeaderIndexes', () => {
  it('keeps nested project rows from replacing their top-level project group header', () => {
    expect(
      getStickyHeaderIndexes([
        makeHeaderRow('project-group:personal', { projectGroupDepth: 0 }),
        makeHeaderRow('repo:autogenie', { projectGroupDepth: 1 }),
        makeWorktreeRow('main'),
        makeHeaderRow('repo:ungrouped', { projectGroupDepth: 0 })
      ])
    ).toEqual([0, 3])
  })

  it('uses the real project-group hierarchy when choosing sticky headers', () => {
    const projectGroup: ProjectGroup = {
      id: 'group-personal',
      name: 'personal',
      parentPath: '/workspace',
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const groupedRepo: Repo = {
      ...repo,
      id: 'repo-autogenie',
      displayName: 'AutoGenie',
      projectGroupId: projectGroup.id,
      projectGroupOrder: 0
    }
    const ungroupedRepo: Repo = { ...repo, id: 'repo-orca', displayName: 'orca' }
    const groupedWorktree: Worktree = {
      ...makeWorktree('main'),
      id: 'wt-autogenie-main',
      repoId: groupedRepo.id,
      isMainWorktree: true
    }
    const ungroupedWorktree: Worktree = {
      ...makeWorktree('main'),
      id: 'wt-orca-main',
      repoId: ungroupedRepo.id,
      isMainWorktree: true
    }
    const rows = buildRows(
      'repo',
      [groupedWorktree, ungroupedWorktree],
      new Map([
        [groupedRepo.id, groupedRepo],
        [ungroupedRepo.id, ungroupedRepo]
      ]),
      null,
      new Set(),
      new Map([
        [groupedRepo.id, 0],
        [ungroupedRepo.id, 1]
      ]),
      undefined,
      'manual',
      undefined,
      undefined,
      false,
      undefined,
      [projectGroup]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-personal',
      'repo:repo-autogenie',
      'repo:repo-orca'
    ])
    expect(getStickyHeaderIndexes(rows)).toEqual([0, 3])
  })
})
