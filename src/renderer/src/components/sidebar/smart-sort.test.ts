import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo, TerminalTab, Worktree } from '../../../../shared/types'
import { buildWorktreeComparator, computeSmartScore } from './smart-sort'

const NOW = new Date('2026-03-27T12:00:00.000Z').getTime()

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
    isArchived: overrides.isArchived ?? false,
    comment: overrides.comment ?? '',
    isUnread: overrides.isUnread ?? false,
    displayName: overrides.displayName ?? overrides.id ?? 'wt-1',
    sortOrder: overrides.sortOrder ?? 0,
    lastActivityAt: overrides.lastActivityAt ?? 0
  }
}

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: overrides.id ?? 'tab-1',
    ptyId: overrides.ptyId ?? 'pty-1',
    worktreeId: overrides.worktreeId ?? 'wt-1',
    title: overrides.title ?? 'bash',
    customTitle: overrides.customTitle ?? null,
    color: overrides.color ?? null,
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: overrides.createdAt ?? 0
  }
}

describe('computeSmartScore', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prioritizes recent activity over a merely linked worktree', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)

    const active = makeWorktree({
      id: 'active',
      displayName: 'Active',
      lastActivityAt: NOW - 10 * 60 * 1000
    })
    const linked = makeWorktree({
      id: 'linked',
      displayName: 'Linked',
      linkedIssue: 42
    })

    const prCache = {
      '/tmp/repo-1::linked': {
        data: { number: 17 },
        fetchedAt: NOW
      }
    }

    expect(computeSmartScore(active, null, repoMap, null)).toBeGreaterThan(
      computeSmartScore(linked, null, repoMap, prCache)
    )
  })

  it('keeps recent activity relevant beyond a one-hour window', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)

    const recent = makeWorktree({
      id: 'recent',
      lastActivityAt: NOW - 2 * 60 * 60 * 1000
    })
    const stale = makeWorktree({
      id: 'stale',
      lastActivityAt: NOW - 30 * 60 * 60 * 1000
    })

    expect(computeSmartScore(recent, null, repoMap, null)).toBeGreaterThan(
      computeSmartScore(stale, null, repoMap, null)
    )
  })

  it('rewards live terminals even without detected agent status', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)

    const withLiveTerminal = makeWorktree({ id: 'live' })
    const withoutLiveTerminal = makeWorktree({ id: 'offline' })
    const tabsByWorktree = {
      [withLiveTerminal.id]: [makeTab({ worktreeId: withLiveTerminal.id, title: 'bash' })]
    }

    expect(computeSmartScore(withLiveTerminal, tabsByWorktree, repoMap, null)).toBeGreaterThan(
      computeSmartScore(withoutLiveTerminal, tabsByWorktree, repoMap, null)
    )
  })

  it('uses the current branch PR cache instead of persisted linkedPR metadata', () => {
    const staleLinked = makeWorktree({
      id: 'stale-linked',
      branch: 'refs/heads/no-pr-anymore',
      linkedPR: 17
    })
    const livePR = makeWorktree({
      id: 'live-pr',
      branch: 'refs/heads/has-pr-now',
      linkedPR: null
    })
    const prCache = {
      '/tmp/repo-1::no-pr-anymore': {
        data: null,
        fetchedAt: NOW
      },
      '/tmp/repo-1::has-pr-now': {
        data: { number: 42 },
        fetchedAt: NOW
      }
    }

    expect(computeSmartScore(livePR, null, repoMap, prCache)).toBeGreaterThan(
      computeSmartScore(staleLinked, null, repoMap, prCache)
    )
  })

  it('falls back to linkedPR when the current branch cache entry is still cold', () => {
    const linked = makeWorktree({
      id: 'linked',
      branch: 'refs/heads/not-fetched-yet',
      linkedPR: 17
    })
    const plain = makeWorktree({
      id: 'plain',
      branch: 'refs/heads/plain',
      linkedPR: null
    })

    expect(computeSmartScore(linked, null, repoMap, {})).toBeGreaterThan(
      computeSmartScore(plain, null, repoMap, {})
    )
  })
})

describe('buildWorktreeComparator', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sorts recent mode by ongoing work signals before alphabetical order', () => {
    const active = makeWorktree({
      id: 'active',
      displayName: 'z-active',
      lastActivityAt: NOW - 10 * 60 * 1000
    })
    const recent = makeWorktree({
      id: 'recent',
      displayName: 'a-recent',
      lastActivityAt: NOW - 90 * 60 * 1000
    })
    const stale = makeWorktree({
      id: 'stale',
      displayName: 'm-stale',
      lastActivityAt: NOW - 3 * 24 * 60 * 60 * 1000
    })

    const worktrees = [recent, stale, active]

    worktrees.sort(buildWorktreeComparator('recent', null, repoMap, null, NOW))

    expect(worktrees.map((worktree) => worktree.id)).toEqual(['active', 'recent', 'stale'])
  })

  it('does not treat selection changes as recent activity', () => {
    const first = makeWorktree({
      id: 'first',
      displayName: 'First',
      sortOrder: NOW,
      lastActivityAt: NOW - 60_000
    })
    const second = makeWorktree({
      id: 'second',
      displayName: 'Second',
      sortOrder: NOW + 10_000,
      lastActivityAt: NOW - 120_000
    })

    const worktrees = [second, first]

    worktrees.sort(buildWorktreeComparator('recent', null, repoMap, null, NOW))

    expect(worktrees.map((worktree) => worktree.id)).toEqual(['first', 'second'])
  })

  it('ignores stale sortOrder metadata when recent activity is identical', () => {
    const alpha = makeWorktree({
      id: 'alpha',
      displayName: 'Alpha',
      sortOrder: NOW + 50_000,
      lastActivityAt: NOW - 60_000
    })
    const beta = makeWorktree({
      id: 'beta',
      displayName: 'Beta',
      sortOrder: NOW - 50_000,
      lastActivityAt: NOW - 60_000
    })

    const worktrees = [beta, alpha]

    worktrees.sort(buildWorktreeComparator('recent', null, repoMap, null, NOW))

    expect(worktrees.map((worktree) => worktree.id)).toEqual(['alpha', 'beta'])
  })

  it('prefers a worktree whose current branch has a live PR over stale linkedPR metadata', () => {
    const staleLinked = makeWorktree({
      id: 'stale-linked',
      displayName: 'Stale Linked',
      branch: 'refs/heads/no-pr-anymore',
      linkedPR: 17
    })
    const livePR = makeWorktree({
      id: 'live-pr',
      displayName: 'Live PR',
      branch: 'refs/heads/has-pr-now'
    })
    const worktrees = [staleLinked, livePR]
    const prCache = {
      '/tmp/repo-1::no-pr-anymore': {
        data: null,
        fetchedAt: NOW
      },
      '/tmp/repo-1::has-pr-now': {
        data: { number: 42 },
        fetchedAt: NOW
      }
    }

    worktrees.sort(buildWorktreeComparator('recent', null, repoMap, prCache, NOW))

    expect(worktrees.map((worktree) => worktree.id)).toEqual(['live-pr', 'stale-linked'])
  })

  it('keeps linkedPR ordering when branch PR cache has not been fetched yet', () => {
    const coldCache = makeWorktree({
      id: 'cold-cache',
      displayName: 'Cold Cache',
      branch: 'refs/heads/not-fetched-yet',
      linkedPR: 17
    })
    const plain = makeWorktree({
      id: 'plain',
      displayName: 'Plain',
      branch: 'refs/heads/plain'
    })
    const worktrees = [plain, coldCache]

    worktrees.sort(buildWorktreeComparator('recent', null, repoMap, {}, NOW))

    expect(worktrees.map((worktree) => worktree.id)).toEqual(['cold-cache', 'plain'])
  })
})
