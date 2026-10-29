import { describe, expect, it } from 'vitest'
import { getRenderRowKey } from '../listing/render-row'
import { getWorktreeDragGroups, getWorktreeDragIndexes } from '../drag/groups'
import { renderRowContainsWorktree } from '../navigation/render-row-lookup'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { Row } from '../../../../../../shared/sidebar-list/row-types'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: '#000',
  addedAt: 1
}

const makeHeaderRow = (key: string): Extract<Row, { type: 'header' }> => ({
  type: 'header',
  key,
  icon: { kind: 'project' },
  label: key,
  count: 0
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
  isLastLineageChild: false,
  lineageChildCount: 0
})

const makePinnedWorktreeRow = (id: string): Extract<Row, { type: 'item' }> => ({
  ...makeWorktreeRow(id),
  rowKey: `pinned:${id}`,
  sectionKey: 'pinned',
  worktree: { ...makeWorktree(id), isPinned: true }
})

const makeNoticeRow = (): Extract<Row, { type: 'new-external-worktrees-inbox' }> => ({
  type: 'new-external-worktrees-inbox',
  key: 'new-external-worktrees-inbox:repo-1',
  repo,
  inboxWorktrees: []
})

describe('hidden-worktree notice virtual rows', () => {
  it('uses stable notice row keys and does not match worktree ids', () => {
    const notice = makeNoticeRow()

    expect(getRenderRowKey(notice)).toBe('inbox:new-external-worktrees-inbox:repo-1')
    expect(renderRowContainsWorktree(notice, 'wt-1')).toBe(false)
  })

  it('keeps notice rows out of worktree drag groups', () => {
    expect(
      getWorktreeDragGroups([
        makeHeaderRow('repo:repo-1'),
        makeWorktreeRow('main'),
        makeNoticeRow(),
        makeWorktreeRow('feature')
      ])
    ).toEqual([{ key: 'repo:repo-1', worktreeIds: ['main', 'feature'] }])
  })

  it('indexes pinned rows for sidebar drag when they are the only rendered copy', () => {
    const rows = [makeHeaderRow('pinned'), makePinnedWorktreeRow('main')]
    const { groupIndexByRowKey, groupKeyByRowKey } = getWorktreeDragIndexes(rows)

    expect(getWorktreeDragGroups(rows)).toEqual([{ key: 'pinned', worktreeIds: ['main'] }])
    expect(groupKeyByRowKey.get('pinned:main')).toBe('pinned')
    expect(groupIndexByRowKey.get('pinned:main')).toBe(0)
  })

  it('uses natural drag metadata when pinned rows have duplicate natural copies', () => {
    const rows = [
      makeHeaderRow('pinned'),
      makePinnedWorktreeRow('main'),
      makeHeaderRow('all'),
      makeWorktreeRow('main')
    ]
    const { groupKeyByRowKey } = getWorktreeDragIndexes(rows)

    expect(getWorktreeDragGroups(rows)).toEqual([{ key: 'all', worktreeIds: ['main'] }])
    expect(groupKeyByRowKey.has('pinned:main')).toBe(false)
    expect(groupKeyByRowKey.get('all:main')).toBe('all')
  })
})
