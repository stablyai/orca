import { describe, expect, it } from 'vitest'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'

import type { Worktree } from '../../../../../../shared/worktree/types'
import { repo, worktree } from './worktree-list-groups-test-fixtures'

import { buildRows } from './build-rows.test-fixture'

const childRepo = { ...repo, id: 'child-repo', displayName: 'Child project', path: '/tmp/child' }
const repos = new Map([
  [repo.id, repo],
  [childRepo.id, childRepo]
])
const parent: Worktree = {
  ...worktree,
  id: 'parent',
  instanceId: 'parent-instance',
  isMainWorktree: true
}
const child: Worktree = {
  ...worktree,
  id: 'child',
  instanceId: 'child-instance',
  repoId: childRepo.id,
  path: '/tmp/child-worktree'
}
const lineage: WorktreeLineage = {
  worktreeId: child.id,
  worktreeInstanceId: 'child-instance',
  parentWorktreeId: parent.id,
  parentWorktreeInstanceId: 'parent-instance',
  origin: 'cli',
  capture: { source: 'terminal-context', confidence: 'inferred' },
  createdAt: 1
}
const lineageById = { [child.id]: lineage }
const worktreeMap = new Map([
  [parent.id, parent],
  [child.id, child]
])

describe('cross-project sidebar lineage', () => {
  it('ranks by actual owner and keeps notices/actions there while counting displayed children', () => {
    const gammaRepo = { ...repo, id: 'gamma', displayName: 'Gamma' }
    const rows = buildRows(
      'repo',
      [
        { ...parent, lastActivityAt: 1 },
        { ...child, lastActivityAt: 100 },
        { ...worktree, id: 'gamma', repoId: gammaRepo.id, lastActivityAt: 50 }
      ],
      new Map([...repos, [gammaRepo.id, gammaRepo]]),
      null,
      new Set(),
      undefined,
      undefined,
      'recent',
      lineageById,
      worktreeMap,
      true,
      undefined,
      [],
      new Set(),
      new Map([[childRepo.id, { repo: childRepo, hiddenWorktrees: [] }]]),
      new Map(),
      [{ creationId: 'creating-child', repoId: childRepo.id }]
    )
    expect(
      rows.filter((row) => row.type === 'header').map((row) => [row.repo?.id, row.count])
    ).toEqual([
      [childRepo.id, 0],
      [gammaRepo.id, 1],
      [repo.id, 2]
    ])
    expect(rows.find((row) => row.type === 'item' && row.worktree.id === child.id)).toMatchObject({
      repo: childRepo,
      sectionKey: `repo:${repo.id}`,
      depth: 1
    })
    const nextSection = rows.findIndex(
      (row) => row.type === 'header' && row.repo?.id === gammaRepo.id
    )
    expect(rows.slice(1, nextSection).map((row) => row.type)).toEqual([
      'imported-worktrees-card',
      'pending-creation'
    ])
    expect(rows.find((row) => row.type === 'pending-creation')).toMatchObject({ repo: childRepo })
  })

  it('keeps a hidden parent child in its own section without redundant context', () => {
    const rows = buildRows(
      'repo',
      [child],
      repos,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      lineageById,
      worktreeMap,
      true
    )
    expect(rows.filter((row) => row.type === 'item')).toMatchObject([
      { worktree: child, sectionKey: `repo:${childRepo.id}`, depth: 0, showProjectName: false }
    ])
  })
})
