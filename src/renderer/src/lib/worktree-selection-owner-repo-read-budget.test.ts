import { expect, it } from 'vitest'
import { findWorktreeForSelectionOwner } from './worktree-selection-owner'
import { makeWorktree } from '../store/slices/worktrees-slice-test-fixtures'
const id = 'repo1::/same/path'
it('does not rescan unrelated repo registration IDs on every cached local-owner lookup', () => {
  let reads = 0
  const n = 100
  const repos = Array.from({ length: n }, (_, i) => ({
    get id() {
      reads++
      return i === 0 ? 'repo1' : `other-${i}`
    },
    path: `/repo/${i}`,
    displayName: 'R',
    badgeColor: 'blue',
    addedAt: 1,
    executionHostId: 'local' as const,
    catalogOwnerHostId: 'local' as const
  }))
  const row = makeWorktree({
    id,
    repoId: 'repo1',
    path: '/same/path',
    hostId: 'local',
    instanceId: 'i0'
  })
  const state = { repos, worktreesByRepo: { repo1: [row] } }
  const owner = {
    worktreeId: id,
    publisherHostId: 'local' as const,
    executionHostId: 'local' as const,
    instanceId: 'i0'
  }
  expect(findWorktreeForSelectionOwner(state, owner)).toBe(row)
  reads = 0
  for (let i = 0; i < 50; i++) {
    expect(findWorktreeForSelectionOwner(state, owner)).toBe(row)
  }
  expect(reads).toBeLessThanOrEqual(2 * n)
})
