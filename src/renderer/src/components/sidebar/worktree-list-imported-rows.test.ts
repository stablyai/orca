import { describe, expect, it } from 'vitest'
import {
  canKeepImportedWorktreesHidden,
  getRenderRowKey,
  getWorktreeDragGroups,
  renderRowContainsWorktree
} from './WorktreeList'
import type { Repo, Worktree } from '../../../../shared/types'
import type { Row } from './worktree-list-groups'

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
  label: key,
  count: 0,
  tone: 'text-foreground'
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
  worktree: makeWorktree(id),
  repo,
  depth: 0,
  lineageTrail: [],
  isLastLineageChild: false,
  lineageChildCount: 0
})

const makeImportedCardRow = (): Extract<Row, { type: 'imported-worktrees-card' }> => ({
  type: 'imported-worktrees-card',
  key: 'imported-worktrees-card:repo-group:repo-1',
  repo,
  hiddenWorktrees: [],
  placement: 'repo-group'
})

describe('imported worktree virtual rows', () => {
  it('uses stable imported row keys and does not match worktree ids', () => {
    const card = makeImportedCardRow()

    expect(getRenderRowKey(card)).toBe('imported:imported-worktrees-card:repo-group:repo-1')
    expect(renderRowContainsWorktree(card, 'wt-1')).toBe(false)
  })

  it('keeps imported card rows out of worktree drag groups', () => {
    expect(
      getWorktreeDragGroups([
        makeHeaderRow('repo:repo-1'),
        makeWorktreeRow('main'),
        makeImportedCardRow(),
        makeWorktreeRow('feature')
      ])
    ).toEqual([{ key: 'repo:repo-1', worktreeIds: ['main', 'feature'] }])
  })

  it('suppresses keep-hidden actions for force-visible rollback failure cards', () => {
    expect(canKeepImportedWorktreesHidden(makeImportedCardRow(), undefined)).toBe(true)
    expect(
      canKeepImportedWorktreesHidden(makeImportedCardRow(), {
        pending: false,
        error: 'Could not show imported worktrees.',
        forceVisible: true
      })
    ).toBe(false)
    expect(
      canKeepImportedWorktreesHidden(
        { ...makeImportedCardRow(), placement: 'pinned-fallback' },
        undefined
      )
    ).toBe(false)
  })
})
