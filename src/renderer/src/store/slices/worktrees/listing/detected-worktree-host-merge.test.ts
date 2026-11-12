import { expect, it } from 'vitest'
import type { DetectedWorktree } from '../../../../../../shared/worktree/types'
import { makeWorktree } from '../worktree.test-fixture'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'
import { mergeDetectedWorktreesForHost } from './detected-worktree-host-merge'

it.each([750, 7500])('does no retention membership work for %i authoritative rows', (size) => {
  const refreshed = makeDetectedResult(
    'repo1',
    Array.from({ length: size }, (_, index) =>
      makeWorktree({ id: `repo1::/checkout/${index}`, repoId: 'repo1' })
    )
  )
  let idReads = 0
  for (const row of refreshed.worktrees) {
    const id = row.id
    Object.defineProperty(row, 'id', {
      enumerable: true,
      get() {
        idReads++
        return id
      }
    })
  }
  const first = mergeDetectedWorktreesForHost(undefined, refreshed, 'local')
  const firstIdReads = idReads
  expect(first.worktrees).toEqual(refreshed.worktrees)
  // One ID read sanitizes review metadata; one reconciles each incoming row.
  expect(firstIdReads).toBeLessThanOrEqual(2 * size)
  idReads = 0
  const equal = mergeDetectedWorktreesForHost(first, refreshed, 'local')
  const equalIdReads = idReads
  expect(equal).toBe(first)
  // Equal refresh additionally indexes each existing row with one lookup and insertion.
  expect(equalIdReads).toBeLessThanOrEqual(4 * size)
})

it('retains incomplete same-host owners, updates positive rows and heals authoritative absence', () => {
  const bare = makeWorktree({ id: 'repo1::/store', repoId: 'repo1', isBare: true })
  const checkout = makeWorktree({ id: 'repo1::/checkout', repoId: 'repo1' })
  const foreign = { ...bare, hostId: 'ssh:other' as const }
  const current = makeDetectedResult('repo1', [bare, checkout, foreign])
  const positive: DetectedWorktree = {
    ...current.worktrees[0],
    branch: 'refs/heads/updated'
  }
  const incomplete = { ...current, authoritative: false, worktrees: [positive] }
  const retained = mergeDetectedWorktreesForHost(current, incomplete, 'local')
  expect(retained.worktrees.map((row) => [row.id, row.hostId, row.branch])).toEqual([
    ['repo1::/store', undefined, 'refs/heads/updated'],
    ['repo1::/checkout', undefined, 'refs/heads/feature'],
    ['repo1::/store', 'ssh:other', 'refs/heads/feature']
  ])
  const healed = mergeDetectedWorktreesForHost(
    retained,
    { ...incomplete, authoritative: true },
    'local'
  )
  expect(healed.worktrees).toEqual([positive, current.worktrees[2]])
})
