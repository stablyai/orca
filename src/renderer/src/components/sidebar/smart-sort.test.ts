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
    linkedIssue: overrides.linkedIssue ?? null,
    linkedPR: overrides.linkedPR ?? null,
    isArchived: overrides.isArchived ?? false,
    comment: overrides.comment ?? '',
    isUnread: overrides.isUnread ?? false,
    displayName: overrides.displayName ?? (overrides.id ?? 'wt-1'),
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

  it('prioritizes the active worktree over a merely linked worktree', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)

    const active = makeWorktree({ id: 'active', displayName: 'Active' })
    const linked = makeWorktree({
      id: 'linked',
      displayName: 'Linked',
      linkedPR: 17,
      linkedIssue: 42
    })

    expect(computeSmartScore(active, null, active.id)).toBeGreaterThan(computeSmartScore(linked, null, active.id))
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

    expect(computeSmartScore(recent, null)).toBeGreaterThan(computeSmartScore(stale, null))
  })

  it('rewards live terminals even without detected agent status', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)

    const withLiveTerminal = makeWorktree({ id: 'live' })
    const withoutLiveTerminal = makeWorktree({ id: 'offline' })
    const tabsByWorktree = {
      [withLiveTerminal.id]: [makeTab({ worktreeId: withLiveTerminal.id, title: 'bash' })]
    }

    expect(computeSmartScore(withLiveTerminal, tabsByWorktree)).toBeGreaterThan(
      computeSmartScore(withoutLiveTerminal, tabsByWorktree)
    )
  })
})

describe('buildWorktreeComparator', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sorts smart mode by ongoing work signals before alphabetical order', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)

    const active = makeWorktree({ id: 'active', displayName: 'z-active' })
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

    worktrees.sort(buildWorktreeComparator('smart', null, repoMap, active.id))

    expect(worktrees.map((worktree) => worktree.id)).toEqual(['active', 'recent', 'stale'])
  })
})
