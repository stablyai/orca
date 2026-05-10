/* eslint-disable max-lines */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo, TerminalTab, Worktree } from '../../../../shared/types'
import {
  buildWorktreeComparator,
  computeSmartScore,
  CREATE_GRACE_MS,
  effectiveRecentActivity,
  type SmartSortOverride
} from './smart-sort'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

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
    linkedLinearIssue: null,
    isArchived: overrides.isArchived ?? false,
    comment: overrides.comment ?? '',
    isUnread: overrides.isUnread ?? false,
    isPinned: overrides.isPinned ?? false,
    displayName: overrides.displayName ?? overrides.id ?? 'wt-1',
    sortOrder: overrides.sortOrder ?? 0,
    lastActivityAt: overrides.lastActivityAt ?? 0,
    ...(overrides.createdAt !== undefined ? { createdAt: overrides.createdAt } : {})
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

function makeAgentStatusEntry(
  overrides: Partial<AgentStatusEntry> & { paneKey: string }
): AgentStatusEntry {
  return {
    state: overrides.state ?? 'working',
    prompt: overrides.prompt ?? '',
    updatedAt: overrides.updatedAt ?? NOW - 30_000,
    stateStartedAt: overrides.stateStartedAt ?? overrides.updatedAt ?? NOW - 30_000,
    agentType: overrides.agentType ?? 'codex',
    paneKey: overrides.paneKey,
    terminalTitle: overrides.terminalTitle,
    stateHistory: overrides.stateHistory ?? []
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

  it('does not let stale explicit status mask a live heuristic permission prompt', () => {
    const worktree = makeWorktree({ id: 'wt-1' })
    const tabsByWorktree = {
      [worktree.id]: [makeTab({ worktreeId: worktree.id, title: 'codex permission needed' })]
    }
    const score = computeSmartScore(worktree, tabsByWorktree, repoMap, null, NOW, {
      'tab-1:1': makeAgentStatusEntry({
        paneKey: 'tab-1:1',
        state: 'done',
        updatedAt: NOW - 45 * 60_000
      })
    })

    expect(score).toBeGreaterThanOrEqual(35)
  })

  it('does not stack heuristic working on top of fresh explicit done for the same tab', () => {
    const worktree = makeWorktree({ id: 'wt-1' })
    const tabsByWorktree = {
      [worktree.id]: [makeTab({ worktreeId: worktree.id, title: 'codex working' })]
    }

    expect(
      computeSmartScore(worktree, tabsByWorktree, repoMap, null, NOW, {
        'tab-1:1': makeAgentStatusEntry({
          paneKey: 'tab-1:1',
          state: 'done',
          updatedAt: NOW - 60_000
        })
      })
    ).toBe(12)
  })
})

describe('buildWorktreeComparator', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sorts smart mode by ongoing work signals before alphabetical order', () => {
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

    worktrees.sort(buildWorktreeComparator('smart', null, repoMap, null, NOW))

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

    worktrees.sort(buildWorktreeComparator('smart', null, repoMap, null, NOW))

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

    worktrees.sort(buildWorktreeComparator('smart', null, repoMap, null, NOW))

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

    worktrees.sort(buildWorktreeComparator('smart', null, repoMap, prCache, NOW))

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

    worktrees.sort(buildWorktreeComparator('smart', null, repoMap, {}, NOW))

    expect(worktrees.map((worktree) => worktree.id)).toEqual(['cold-cache', 'plain'])
  })

  it('can freeze the active worktree recent signals without blocking background reordering', () => {
    const activeBeforeClick = makeWorktree({
      id: 'active',
      displayName: 'Active',
      isUnread: true,
      lastActivityAt: NOW - 30_000
    })
    const activeAfterClick = { ...activeBeforeClick, isUnread: false }
    const background = makeWorktree({
      id: 'background',
      displayName: 'Background',
      lastActivityAt: NOW - 60_000
    })
    const worktrees = [background, activeAfterClick]
    const tabsByWorktree = {
      [background.id]: [makeTab({ worktreeId: background.id, title: 'Claude Code - working' })]
    }
    const smartSortOverrides: Record<string, SmartSortOverride> = {
      [activeAfterClick.id]: {
        worktree: activeBeforeClick,
        tabs: [],
        hasRecentPRSignal: false
      }
    }

    worktrees.sort(
      buildWorktreeComparator('smart', tabsByWorktree, repoMap, null, NOW, smartSortOverrides)
    )

    expect(worktrees.map((worktree) => worktree.id)).toEqual(['background', 'active'])
  })

  it('can keep the active worktree in place while its unread badge is cleared on selection', () => {
    const activeBeforeClick = makeWorktree({
      id: 'active',
      displayName: 'Active',
      isUnread: true,
      lastActivityAt: NOW - 30_000
    })
    const activeAfterClick = { ...activeBeforeClick, isUnread: false }
    const background = makeWorktree({
      id: 'background',
      displayName: 'Background',
      lastActivityAt: NOW - 2 * 60_000
    })
    const worktrees = [background, activeAfterClick]
    const smartSortOverrides: Record<string, SmartSortOverride> = {
      [activeAfterClick.id]: {
        worktree: activeBeforeClick,
        tabs: [],
        hasRecentPRSignal: false
      }
    }

    worktrees.sort(buildWorktreeComparator('smart', null, repoMap, null, NOW, smartSortOverrides))

    expect(worktrees.map((worktree) => worktree.id)).toEqual(['active', 'background'])
  })

  it('keeps a more recent worktree ahead even without an override', () => {
    const activeAfterClick = makeWorktree({
      id: 'active',
      displayName: 'Active',
      isUnread: false,
      lastActivityAt: NOW - 30_000
    })
    const background = makeWorktree({
      id: 'background',
      displayName: 'Background',
      lastActivityAt: NOW - 2 * 60_000
    })
    const worktrees = [background, activeAfterClick]

    worktrees.sort(buildWorktreeComparator('smart', null, repoMap, null, NOW))

    expect(worktrees.map((worktree) => worktree.id)).toEqual(['active', 'background'])
  })

  it('ranks a just-created worktree above shutdown worktrees with passive signals', () => {
    const justCreated = makeWorktree({
      id: 'new',
      displayName: 'New',
      lastActivityAt: NOW
    })
    // Shutdown worktree with max passive signals but no recent activity
    const shutdown = makeWorktree({
      id: 'shutdown',
      displayName: 'Shutdown',
      isUnread: true,
      linkedIssue: 42,
      lastActivityAt: NOW - 2 * 24 * 60 * 60 * 1000
    })
    const prCache = {
      '/tmp/repo-1::shutdown': {
        data: { number: 17 },
        fetchedAt: NOW
      }
    }
    const worktrees = [shutdown, justCreated]

    worktrees.sort(buildWorktreeComparator('smart', null, repoMap, prCache, NOW))

    expect(worktrees.map((worktree) => worktree.id)).toEqual(['new', 'shutdown'])
  })
})

describe('buildWorktreeComparator — recent (lastActivityAt)', () => {
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

    worktrees.sort(buildWorktreeComparator('recent', null, repoMap, null, NOW))

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

    worktrees.sort(buildWorktreeComparator('recent', null, repoMap, null, NOW))

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

    worktrees.sort(buildWorktreeComparator('recent', null, repoMap, null, NOW))

    expect(worktrees.map((w) => w.id)).toEqual(['alpha', 'bravo'])
  })

  it('ignores sortOrder entirely — activity alone determines the order', () => {
    // A worktree with a stale high sortOrder (e.g. baked in when meta was
    // first created) must not outrank a worktree with fresher activity.
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

    worktrees.sort(buildWorktreeComparator('recent', null, repoMap, null, NOW))

    expect(worktrees.map((w) => w.id)).toEqual(['fresh-active', 'stale-high-order'])
  })
})

describe('effectiveRecentActivity — create-grace floor', () => {
  it('returns lastActivityAt when createdAt is absent', () => {
    const wt = makeWorktree({ id: 'old', lastActivityAt: 12345 })
    expect(effectiveRecentActivity(wt, NOW)).toBe(12345)
  })

  it('returns createdAt + CREATE_GRACE_MS when grace window exceeds lastActivityAt', () => {
    const wt = makeWorktree({ id: 'fresh', lastActivityAt: NOW, createdAt: NOW })
    expect(effectiveRecentActivity(wt, NOW)).toBe(NOW + CREATE_GRACE_MS)
  })

  it('returns lastActivityAt when grace window has elapsed', () => {
    const wt = makeWorktree({
      id: 'post-grace',
      createdAt: NOW - CREATE_GRACE_MS - 60_000,
      lastActivityAt: NOW - 1000
    })
    expect(effectiveRecentActivity(wt, NOW)).toBe(NOW - 1000)
  })

  it('returns lastActivityAt when real activity has surpassed the grace floor', () => {
    // A user who interacted 3 minutes after create has lastActivityAt > createdAt + 3min,
    // but createdAt + 5min still wins for the next 2 minutes.
    const createdAt = NOW - 3 * 60 * 1000
    const wt = makeWorktree({ id: 'used', createdAt, lastActivityAt: NOW - 60_000 })
    // createdAt + GRACE_MS = NOW + 2min, which exceeds lastActivityAt (NOW - 1min).
    expect(effectiveRecentActivity(wt, NOW)).toBe(createdAt + CREATE_GRACE_MS)
  })

  it('returns lastActivityAt once the grace window has elapsed even when no other activity has occurred', () => {
    // Bug-fix case: a worktree created days ago that was never touched after
    // creation. Without the time-bound check, the floor would still apply and
    // the worktree would rank as `createdAt + 5min` forever, masking truly
    // fresher worktrees.
    const createdAt = NOW - CREATE_GRACE_MS - 1
    const wt = makeWorktree({ id: 'untouched', createdAt, lastActivityAt: createdAt })
    expect(effectiveRecentActivity(wt, NOW)).toBe(createdAt)
  })
})

describe('buildWorktreeComparator — recent with createdAt grace window', () => {
  it('keeps a newly-created worktree on top even when another worktree bumps lastActivityAt', () => {
    // Simulates the bug: user creates a worktree at t=0, then an ambient PTY
    // bump on a different worktree lands at t=+100ms. Without the grace
    // window, the bumped worktree would outrank the new one by 100ms.
    const newWorktree = makeWorktree({
      id: 'new',
      displayName: 'New',
      createdAt: NOW,
      lastActivityAt: NOW
    })
    const bumpedByAmbient = makeWorktree({
      id: 'bumped',
      displayName: 'Bumped',
      lastActivityAt: NOW + 100
    })
    const worktrees = [bumpedByAmbient, newWorktree]

    worktrees.sort(buildWorktreeComparator('recent', null, repoMap, null, NOW))

    expect(worktrees.map((w) => w.id)).toEqual(['new', 'bumped'])
  })

  it('falls through to normal recency once the grace window has elapsed', () => {
    const oldCreated = makeWorktree({
      id: 'old-created',
      displayName: 'Old created',
      // Created longer ago than GRACE_MS so the floor has expired.
      createdAt: NOW - CREATE_GRACE_MS - 10_000,
      lastActivityAt: NOW - 30_000
    })
    const freshActivity = makeWorktree({
      id: 'fresh-activity',
      displayName: 'Fresh activity',
      // No createdAt (discovered on disk), but has recent real activity.
      lastActivityAt: NOW - 1000
    })
    const worktrees = [oldCreated, freshActivity]

    worktrees.sort(buildWorktreeComparator('recent', null, repoMap, null, NOW))

    expect(worktrees.map((w) => w.id)).toEqual(['fresh-activity', 'old-created'])
  })

  it('does not disturb ranking for worktrees without createdAt', () => {
    // All existing worktrees (persisted before createdAt field existed) stay
    // sorted by lastActivityAt alone.
    const alpha = makeWorktree({ id: 'alpha', displayName: 'Alpha', lastActivityAt: 5000 })
    const bravo = makeWorktree({ id: 'bravo', displayName: 'Bravo', lastActivityAt: 10_000 })
    const worktrees = [alpha, bravo]

    worktrees.sort(buildWorktreeComparator('recent', null, repoMap, null, NOW))

    expect(worktrees.map((w) => w.id)).toEqual(['bravo', 'alpha'])
  })
})
