import { describe, expect, it } from 'vitest'
import { buildCollectionRows, insertCollectionRowsAfterPinned } from './worktree-list-collections'
import type { Row } from './worktree-list/grouping/row-types'
import type { Collection } from '../../../../shared/collection-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

function makeRepo(id: string, displayName: string): Repo {
  return { id, path: `/repo/${id}`, displayName, badgeColor: '#000', addedAt: 1 }
}

function makeCollection(id: string, name: string, order: number, isCollapsed = false): Collection {
  return { id, name, color: null, isCollapsed, order, createdAt: 1, updatedAt: 1 }
}

function makeWorktree(id: string, repoId: string, collectionIds?: string[]): Worktree {
  return {
    id,
    repoId,
    path: `/wt/${id}`,
    head: 'abc123',
    branch: `refs/heads/${id}`,
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...(collectionIds ? { collectionIds } : {})
  }
}

function rowKeys(rows: ReturnType<typeof buildCollectionRows>): string[] {
  return rows.map((row) =>
    row.type === 'header' ? row.key : row.type === 'item' ? row.rowKey : ''
  )
}

const api = makeRepo('repo-api', 'api')
const frontend = makeRepo('repo-frontend', 'frontend')
const repoMap = new Map([
  [api.id, api],
  [frontend.id, frontend]
])
const repoOrder = new Map([
  [api.id, 0],
  [frontend.id, 1]
])

describe('buildCollectionRows', () => {
  it('returns no rows when there are no collections', () => {
    expect(
      buildCollectionRows({
        collections: [],
        worktrees: [makeWorktree('wt-1', api.id, ['ghost'])],
        repoMap,
        collapsedGroups: new Set()
      })
    ).toEqual([])
  })

  it('renders the same repo under every collection it has members in', () => {
    const approvals = makeCollection('c-approvals', 'Approve PRs', 0)
    const billing = makeCollection('c-billing', 'Billing migration', 1)
    const rows = buildCollectionRows({
      collections: [billing, approvals],
      worktrees: [
        makeWorktree('wt-ptal', api.id, [approvals.id]),
        makeWorktree('wt-schema', api.id, [billing.id]),
        makeWorktree('wt-recurrence', frontend.id, [approvals.id])
      ],
      repoMap,
      collapsedGroups: new Set(),
      repoOrder
    })
    expect(rowKeys(rows)).toEqual([
      'collection:c-approvals',
      'collection:c-approvals:repo:repo-api',
      'collection:c-approvals:wt-ptal',
      'collection:c-approvals:repo:repo-frontend',
      'collection:c-approvals:wt-recurrence',
      'collection:c-billing',
      'collection:c-billing:repo:repo-api',
      'collection:c-billing:wt-schema'
    ])
  })

  it('renders a worktree in every collection it belongs to (many-to-many)', () => {
    const approvals = makeCollection('c-approvals', 'Approve PRs', 0)
    const billing = makeCollection('c-billing', 'Billing migration', 1)
    const rows = buildCollectionRows({
      collections: [approvals, billing],
      worktrees: [makeWorktree('wt-shared', api.id, [approvals.id, billing.id])],
      repoMap,
      collapsedGroups: new Set(),
      repoOrder
    })
    expect(rowKeys(rows)).toEqual([
      'collection:c-approvals',
      'collection:c-approvals:repo:repo-api',
      'collection:c-approvals:wt-shared',
      'collection:c-billing',
      'collection:c-billing:repo:repo-api',
      'collection:c-billing:wt-shared'
    ])
  })

  it('keeps an empty collection header visible', () => {
    const empty = makeCollection('c-empty', 'Someday', 0)
    const rows = buildCollectionRows({
      collections: [empty],
      worktrees: [makeWorktree('wt-1', api.id)],
      repoMap,
      collapsedGroups: new Set()
    })
    expect(rowKeys(rows)).toEqual(['collection:c-empty'])
    expect(rows[0]).toMatchObject({ type: 'header', count: 0 })
  })

  it('hides children when the collection header key is collapsed', () => {
    const approvals = makeCollection('c-approvals', 'Approve PRs', 0)
    const rows = buildCollectionRows({
      collections: [approvals],
      worktrees: [makeWorktree('wt-ptal', api.id, [approvals.id])],
      repoMap,
      collapsedGroups: new Set(['collection:c-approvals'])
    })
    expect(rowKeys(rows)).toEqual(['collection:c-approvals'])
    expect(rows[0]).toMatchObject({ count: 1 })
  })

  it('hides only that repo block when a repo sub-header is collapsed', () => {
    const approvals = makeCollection('c-approvals', 'Approve PRs', 0)
    const rows = buildCollectionRows({
      collections: [approvals],
      worktrees: [
        makeWorktree('wt-ptal', api.id, [approvals.id]),
        makeWorktree('wt-recurrence', frontend.id, [approvals.id])
      ],
      repoMap,
      collapsedGroups: new Set(['collection:c-approvals:repo:repo-api']),
      repoOrder
    })
    expect(rowKeys(rows)).toEqual([
      'collection:c-approvals',
      'collection:c-approvals:repo:repo-api',
      'collection:c-approvals:repo:repo-frontend',
      'collection:c-approvals:wt-recurrence'
    ])
  })

  it('ignores memberships pointing at unknown collections', () => {
    const approvals = makeCollection('c-approvals', 'Approve PRs', 0)
    const rows = buildCollectionRows({
      collections: [approvals],
      worktrees: [makeWorktree('wt-1', api.id, ['deleted-collection'])],
      repoMap,
      collapsedGroups: new Set()
    })
    expect(rowKeys(rows)).toEqual(['collection:c-approvals'])
  })

  it('slots collection rows between the pinned section and the project list', () => {
    const header = (key: string): Row => ({ type: 'header', key, label: key, count: 1, tone: '' })
    const item = (rowKey: string, sectionKey: string): Row => ({
      type: 'item',
      rowKey,
      sectionKey,
      worktree: makeWorktree(rowKey, api.id),
      repo: api,
      depth: 0,
      groupDepth: 0,
      lineageTrail: [],
      isLastLineageChild: false,
      lineageChildCount: 0
    })
    const collectionRows = [header('collection:c1')]

    const withPinned = insertCollectionRowsAfterPinned(
      [
        header('pinned'),
        item('wt-pinned', 'pinned'),
        header('repo:repo-api'),
        item('wt-a', 'repo:repo-api')
      ],
      collectionRows
    )
    expect(
      withPinned.map((row) =>
        row.type === 'header' ? row.key : row.type === 'item' ? row.rowKey : ''
      )
    ).toEqual(['pinned', 'wt-pinned', 'collection:c1', 'repo:repo-api', 'wt-a'])

    const withoutPinned = insertCollectionRowsAfterPinned(
      [header('repo:repo-api'), item('wt-a', 'repo:repo-api')],
      collectionRows
    )
    expect(withoutPinned.map((row) => (row.type === 'header' ? row.key : ''))[0]).toBe(
      'collection:c1'
    )

    expect(insertCollectionRowsAfterPinned([header('repo:repo-api')], [])).toEqual([
      header('repo:repo-api')
    ])
  })

  it('orders collections by order then name', () => {
    const rows = buildCollectionRows({
      collections: [
        makeCollection('c-b', 'Beta', 1),
        makeCollection('c-a', 'Alpha', 1),
        makeCollection('c-z', 'Zulu', 0)
      ],
      worktrees: [],
      repoMap,
      collapsedGroups: new Set()
    })
    expect(rowKeys(rows)).toEqual(['collection:c-z', 'collection:c-a', 'collection:c-b'])
  })
})
