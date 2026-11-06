import { describe, expect, it } from 'vitest'

import { getWorktreeDragGroups, getWorktreeDragIndexes } from '../drag/groups'

import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { Row } from '../../../../../../shared/sidebar-list/row-types'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'

// Drag groups key members by host identity; these rows carry no host.
const k = (id: string): string => composeWorktreeHostIdentity(undefined, id)

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

describe('imported worktree virtual rows', () => {
  it('uses natural drag metadata when pinned rows have duplicate natural copies', () => {
    const rows = [
      makeHeaderRow('pinned'),
      makePinnedWorktreeRow('main'),
      makeHeaderRow('all'),
      makeWorktreeRow('main')
    ]
    const { groupKeyByRowKey } = getWorktreeDragIndexes(rows)

    expect(getWorktreeDragGroups(rows)).toEqual([{ key: 'all', worktreeIds: [k('main')] }])
    expect(groupKeyByRowKey.has('pinned:main')).toBe(false)
    expect(groupKeyByRowKey.get('all:main')).toBe('all')
  })
})
