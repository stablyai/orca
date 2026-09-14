import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list/grouping/build-rows'
import type { PendingCreationRef } from './worktree-list/grouping/row-types'
import { repo, worktree, repoMap } from './worktree-list-groups-test-fixtures'

describe('buildRows pending creations', () => {
  function makePendingCreation(creationId: string, repoId: string): PendingCreationRef {
    return { creationId, repoId }
  }

  it('nests a pending creation under its repo, above the repo worktrees', () => {
    const rows = buildRows(
      'repo',
      [worktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map(),
      [makePendingCreation('c1', repo.id)]
    )

    const types = rows.map((row) => row.type)
    const headerIndex = types.indexOf('header')
    const pendingIndex = rows.findIndex(
      (row) => row.type === 'pending-creation' && row.creationId === 'c1'
    )
    const itemIndex = types.indexOf('item')
    expect(headerIndex).toBeGreaterThanOrEqual(0)
    expect(pendingIndex).toBe(headerIndex + 1)
    expect(pendingIndex).toBeLessThan(itemIndex)
  })

  it('creates a repo group for a pending creation in a repo with no worktrees yet', () => {
    const rows = buildRows(
      'repo',
      [],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map(),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map(),
      [makePendingCreation('c1', repo.id)]
    )

    expect(rows.map((row) => row.type)).toEqual(['header', 'pending-creation'])
  })

  it('keeps a pending creation visible when its repo metadata is temporarily missing', () => {
    const rows = buildRows(
      'repo',
      [],
      new Map(),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map(),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map(),
      [makePendingCreation('c1', repo.id)]
    )

    expect(rows).toMatchObject([
      { type: 'header', key: `repo:${repo.id}`, label: 'Unknown' },
      { type: 'pending-creation', creationId: 'c1', repo: undefined }
    ])
  })

  it('surfaces pending creations at the top for non-repo groupings', () => {
    const rows = buildRows(
      'none',
      [worktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map(),
      [makePendingCreation('c1', repo.id)]
    )

    expect(rows[0]).toMatchObject({ type: 'pending-creation', creationId: 'c1' })
  })
})
