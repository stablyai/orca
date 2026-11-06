import { describe, expect, it } from 'vitest'
import { makeWorktree as makeStoreWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { buildCollectionRows, insertCollectionRowsAfterPinned } from './worktree-list-collections'
import type { Row } from '../../../../shared/sidebar-list/row-types'
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
  return makeStoreWorktree({ id, repoId, collectionIds })
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

  it('renders repos and worktrees under every collection they belong to', () => {
    const approvals = makeCollection('c-approvals', 'Approve PRs', 0)
    const billing = makeCollection('c-billing', 'Billing migration', 1)
    const rows = buildCollectionRows({
      collections: [billing, approvals],
      worktrees: [
        makeWorktree('wt-ptal', api.id, [approvals.id, billing.id]),
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
      'collection:c-billing:wt-ptal',
      'collection:c-billing:wt-schema'
    ])
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

  it('ignores unknown memberships and keeps an empty collection header visible', () => {
    const approvals = makeCollection('c-approvals', 'Approve PRs', 0)
    const rows = buildCollectionRows({
      collections: [approvals],
      worktrees: [makeWorktree('wt-1', api.id, ['deleted-collection'])],
      repoMap,
      collapsedGroups: new Set()
    })
    expect(rowKeys(rows)).toEqual(['collection:c-approvals'])
    expect(rows[0]).toMatchObject({ type: 'header', count: 0 })
  })

  it('slots collection rows between the pinned section and the project list', () => {
    const header = (key: string): Row => ({
      type: 'header',
      key,
      label: key,
      count: 1,
      icon: { kind: 'collection' }
    })
    const item = (rowKey: string, sectionKey: string): Row => ({
      type: 'item',
      rowKey,
      sectionKey,
      worktree: makeWorktree(rowKey, api.id),
      repo: api,
      depth: 0,
      groupDepth: 0,
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
})
