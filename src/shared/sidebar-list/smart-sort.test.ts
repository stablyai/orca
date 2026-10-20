import { describe, expect, it } from 'vitest'
import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import { sortWorktreesByStamps } from './smart-sort'

// Smart and Recent order by the owning host's stamps (stamp-order.test.ts); no window attention sort.

const repoMap = new Map<string, Repo>([
  [
    'repo-1',
    {
      id: 'repo-1',
      path: '/tmp/repo-1',
      displayName: 'repo-1',
      badgeColor: '#000000',
      addedAt: 0
    }
  ]
])

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: overrides.id ?? 'wt-1',
    repoId: overrides.repoId ?? 'repo-1',
    path: overrides.path ?? `/tmp/${overrides.id ?? 'wt-1'}`,
    branch: overrides.branch ?? `refs/heads/${overrides.id ?? 'wt-1'}`,
    head: overrides.head ?? 'abc123',
    isBare: overrides.isBare ?? false,
    isMainWorktree: overrides.isMainWorktree ?? false,
    linkedIssue: overrides.linkedIssue ?? null,
    linkedPR: overrides.linkedPR ?? null,
    linkedLinearIssue: null,
    isArchived: overrides.isArchived ?? false,
    comment: overrides.comment ?? '',
    isUnread: overrides.isUnread ?? false,
    isPinned: overrides.isPinned ?? false,
    displayName: overrides.displayName ?? overrides.id ?? 'wt-1',
    sortOrder: overrides.sortOrder ?? 0,
    lastActivityAt: overrides.lastActivityAt ?? 0
  }
}

describe('sortWorktreesByStamps — labels', () => {
  it('falls back to the path label when a persisted worktree has no displayName', () => {
    const missingDisplayName = {
      ...makeWorktree({
        id: 'missing-display-name',
        path: '/tmp/alpha-path',
        sortOrder: 1
      }),
      displayName: undefined
    } as unknown as Worktree
    const named = makeWorktree({ id: 'named', displayName: 'Zulu', sortOrder: 1 })

    const sorted = sortWorktreesByStamps([named, missingDisplayName], 'smart', repoMap)

    expect(sorted.map((w) => w.id)).toEqual(['missing-display-name', 'named'])
  })
})

describe('sortWorktreesByStamps — recent (lastActivityAt)', () => {
  it('sorts by lastActivityAt descending (most recent first)', () => {
    const older = makeWorktree({
      id: 'older',
      displayName: 'Older',
      lastActivityAt: 1000
    })
    const newer = makeWorktree({
      id: 'newer',
      displayName: 'Newer',
      lastActivityAt: 2000
    })
    const worktrees = [older, newer]

    sortWorktreesByStamps(worktrees, 'recent', repoMap)

    expect(worktrees.map((w) => w.id)).toEqual(['newer', 'older'])
  })

  it('sorts worktrees with lastActivityAt 0 to the bottom', () => {
    const touched = makeWorktree({
      id: 'touched',
      displayName: 'Touched',
      lastActivityAt: 1000
    })
    const legacy = makeWorktree({
      id: 'legacy',
      displayName: 'Legacy',
      lastActivityAt: 0
    })
    const worktrees = [legacy, touched]

    sortWorktreesByStamps(worktrees, 'recent', repoMap)

    expect(worktrees.map((w) => w.id)).toEqual(['touched', 'legacy'])
  })

  it('falls back to alphabetical when lastActivityAt is equal', () => {
    const bravo = makeWorktree({
      id: 'bravo',
      displayName: 'Bravo',
      lastActivityAt: 1000
    })
    const alpha = makeWorktree({
      id: 'alpha',
      displayName: 'Alpha',
      lastActivityAt: 1000
    })
    const worktrees = [bravo, alpha]

    sortWorktreesByStamps(worktrees, 'recent', repoMap)

    expect(worktrees.map((w) => w.id)).toEqual(['alpha', 'bravo'])
  })

  it('ignores sortOrder entirely — activity alone determines the order', () => {
    const staleHighOrder = makeWorktree({
      id: 'stale-high-order',
      displayName: 'Orca main',
      sortOrder: 9_999_999_999_999,
      lastActivityAt: 1000
    })
    const freshActive = makeWorktree({
      id: 'fresh-active',
      displayName: 'Other repo',
      sortOrder: 1,
      lastActivityAt: 5000
    })
    const worktrees = [staleHighOrder, freshActive]

    sortWorktreesByStamps(worktrees, 'recent', repoMap)

    expect(worktrees.map((w) => w.id)).toEqual(['fresh-active', 'stale-high-order'])
  })
})

describe('sortWorktreesByStamps — manual order', () => {
  it('orders by persisted manualOrder with higher values first', () => {
    const first = makeWorktree({ id: 'first', displayName: 'First', manualOrder: 3000 })
    const second = makeWorktree({ id: 'second', displayName: 'Second', manualOrder: 2000 })
    const worktrees = [second, first]

    sortWorktreesByStamps(worktrees, 'manual', repoMap)

    expect(worktrees.map((w) => w.id)).toEqual(['first', 'second'])
  })

  it('falls back to sortOrder before a workspace has manualOrder', () => {
    const restoredTop = makeWorktree({
      id: 'restored-top',
      displayName: 'Restored Top',
      sortOrder: 5000
    })
    const restoredBottom = makeWorktree({
      id: 'restored-bottom',
      displayName: 'Restored Bottom',
      sortOrder: 1000
    })
    const worktrees = [restoredBottom, restoredTop]

    sortWorktreesByStamps(worktrees, 'manual', repoMap)

    expect(worktrees.map((w) => w.id)).toEqual(['restored-top', 'restored-bottom'])
  })
})
