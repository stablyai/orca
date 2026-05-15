/* eslint-disable max-lines */
import { describe, expect, it } from 'vitest'
import type { Repo, TerminalTab, Worktree } from '../../../../shared/types'
import {
  buildWorktreeComparator,
  CREATE_GRACE_MS,
  effectiveRecentActivity,
  sortWorktreesSmart
} from './smart-sort'
import { buildAttentionByWorktree } from './smart-attention'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStateHistoryEntry,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'

const NOW = new Date('2026-03-27T12:00:00.000Z').getTime()
const LEAF_ID_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_ID_2 = '22222222-2222-4222-8222-222222222222'

function paneKey(tabId: string, leaf: '1' | '2' = '1'): string {
  return makePaneKey(tabId, leaf === '1' ? LEAF_ID_1 : LEAF_ID_2)
}

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

function makeEntry(overrides: Partial<AgentStatusEntry> & { paneKey: string }): AgentStatusEntry {
  return {
    state: overrides.state ?? 'working',
    prompt: overrides.prompt ?? '',
    updatedAt: overrides.updatedAt ?? NOW - 30_000,
    stateStartedAt: overrides.stateStartedAt ?? overrides.updatedAt ?? NOW - 30_000,
    agentType: overrides.agentType ?? 'codex',
    paneKey: overrides.paneKey,
    terminalTitle: overrides.terminalTitle,
    stateHistory: overrides.stateHistory ?? [],
    interrupted: overrides.interrupted
  }
}

function makeHistory(
  state: AgentStateHistoryEntry['state'],
  startedAt: number,
  interrupted = false
): AgentStateHistoryEntry {
  return { state, prompt: '', startedAt, interrupted: interrupted || undefined }
}

function ptyMapForTabs(tabsByWorktree: Record<string, TerminalTab[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const tabs of Object.values(tabsByWorktree)) {
    for (const tab of tabs) {
      out[tab.id] = ['pty-1']
    }
  }
  return out
}

/**
 * Sort helper: builds the attention map and runs the smart comparator. Mirrors
 * what callers do in production (visible-worktrees, WorktreeList).
 */
function sortSmart(
  worktrees: Worktree[],
  tabsByWorktree: Record<string, TerminalTab[]>,
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
): Worktree[] {
  const attention = buildAttentionByWorktree(
    worktrees,
    tabsByWorktree,
    agentStatusByPaneKey,
    {},
    ptyMapForTabs(tabsByWorktree),
    NOW
  )
  return [...worktrees].sort(buildWorktreeComparator('smart', repoMap, NOW, attention))
}

describe('smart sort — class invariants', () => {
  it('ranks blocked above done regardless of which stateStartedAt is newer', () => {
    const blocked = makeWorktree({ id: 'blocked', displayName: 'Blocked' })
    const done = makeWorktree({ id: 'done', displayName: 'Done' })
    const tabs = {
      [blocked.id]: [makeTab({ id: 'tab-blocked', worktreeId: blocked.id })],
      [done.id]: [makeTab({ id: 'tab-done', worktreeId: done.id })]
    }
    const entries = {
      [paneKey('tab-blocked', '1')]: makeEntry({
        paneKey: paneKey('tab-blocked', '1'),
        state: 'blocked',
        // older than the done timestamp
        stateStartedAt: NOW - 5 * 60_000,
        updatedAt: NOW - 1_000
      }),
      [paneKey('tab-done', '1')]: makeEntry({
        paneKey: paneKey('tab-done', '1'),
        state: 'done',
        // newer
        stateStartedAt: NOW - 10_000,
        updatedAt: NOW - 1_000
      })
    }
    const sorted = sortSmart([done, blocked], tabs, entries)
    expect(sorted.map((w) => w.id)).toEqual(['blocked', 'done'])
  })

  it('ranks done above working', () => {
    const done = makeWorktree({ id: 'done', displayName: 'Done' })
    const working = makeWorktree({ id: 'working', displayName: 'Working' })
    const tabs = {
      [done.id]: [makeTab({ id: 'tab-done', worktreeId: done.id })],
      [working.id]: [makeTab({ id: 'tab-working', worktreeId: working.id })]
    }
    const entries = {
      [paneKey('tab-done', '1')]: makeEntry({
        paneKey: paneKey('tab-done', '1'),
        state: 'done',
        stateStartedAt: NOW - 10 * 60_000,
        updatedAt: NOW - 1_000
      }),
      [paneKey('tab-working', '1')]: makeEntry({
        paneKey: paneKey('tab-working', '1'),
        state: 'working',
        // newer than the done — must still lose because class wins
        stateStartedAt: NOW - 1_000,
        updatedAt: NOW - 500
      })
    }
    const sorted = sortSmart([working, done], tabs, entries)
    expect(sorted.map((w) => w.id)).toEqual(['done', 'working'])
  })

  it('ranks working above idle', () => {
    const working = makeWorktree({ id: 'working', displayName: 'Working' })
    const idle = makeWorktree({
      id: 'idle',
      displayName: 'Idle',
      // Make sure idle's effective recency is high enough that without the
      // class layer it would outrank the working worktree on a recency tie.
      lastActivityAt: NOW - 1_000
    })
    const tabs = {
      [working.id]: [makeTab({ id: 'tab-working', worktreeId: working.id })],
      [idle.id]: [makeTab({ id: 'tab-idle', worktreeId: idle.id })]
    }
    const entries = {
      [paneKey('tab-working', '1')]: makeEntry({
        paneKey: paneKey('tab-working', '1'),
        state: 'working',
        stateStartedAt: NOW - 60_000,
        updatedAt: NOW - 1_000
      })
    }
    const sorted = sortSmart([idle, working], tabs, entries)
    expect(sorted.map((w) => w.id)).toEqual(['working', 'idle'])
  })
})

describe('smart sort — within-class recency', () => {
  it('orders two blocked worktrees by stateStartedAt (newer first)', () => {
    const older = makeWorktree({ id: 'older', displayName: 'A-Older' })
    const newer = makeWorktree({ id: 'newer', displayName: 'B-Newer' })
    const tabs = {
      [older.id]: [makeTab({ id: 'tab-older', worktreeId: older.id })],
      [newer.id]: [makeTab({ id: 'tab-newer', worktreeId: newer.id })]
    }
    const entries = {
      [paneKey('tab-older', '1')]: makeEntry({
        paneKey: paneKey('tab-older', '1'),
        state: 'blocked',
        stateStartedAt: NOW - 5 * 60_000,
        updatedAt: NOW - 1_000
      }),
      [paneKey('tab-newer', '1')]: makeEntry({
        paneKey: paneKey('tab-newer', '1'),
        state: 'blocked',
        stateStartedAt: NOW - 30_000,
        updatedAt: NOW - 1_000
      })
    }
    const sorted = sortSmart([older, newer], tabs, entries)
    expect(sorted.map((w) => w.id)).toEqual(['newer', 'older'])
  })

  it('ranks a working worktree with prior done above one with no history', () => {
    const withHistory = makeWorktree({ id: 'with-history', displayName: 'A-WithHistory' })
    const fresh = makeWorktree({ id: 'fresh', displayName: 'B-Fresh' })
    const tabs = {
      [withHistory.id]: [makeTab({ id: 'tab-with', worktreeId: withHistory.id })],
      [fresh.id]: [makeTab({ id: 'tab-fresh', worktreeId: fresh.id })]
    }
    const entries = {
      [paneKey('tab-with', '1')]: makeEntry({
        paneKey: paneKey('tab-with', '1'),
        state: 'working',
        stateStartedAt: NOW - 60_000,
        updatedAt: NOW - 1_000,
        // Prior done from earlier in the session bumps within-class recency.
        stateHistory: [makeHistory('done', NOW - 5_000)]
      }),
      [paneKey('tab-fresh', '1')]: makeEntry({
        paneKey: paneKey('tab-fresh', '1'),
        state: 'working',
        // Even newer current stateStartedAt — but with no history, falls back
        // to this timestamp (older than the prior done above).
        stateStartedAt: NOW - 2 * 60_000,
        updatedAt: NOW - 1_000
      })
    }
    const sorted = sortSmart([fresh, withHistory], tabs, entries)
    expect(sorted.map((w) => w.id)).toEqual(['with-history', 'fresh'])
  })

  it('falls back to current stateStartedAt when history is only interrupted dones', () => {
    const onlyInterrupted = makeWorktree({
      id: 'only-interrupted',
      displayName: 'A-OnlyInterrupted'
    })
    const fresh = makeWorktree({ id: 'fresh', displayName: 'B-Fresh' })
    const tabs = {
      [onlyInterrupted.id]: [makeTab({ id: 'tab-i', worktreeId: onlyInterrupted.id })],
      [fresh.id]: [makeTab({ id: 'tab-f', worktreeId: fresh.id })]
    }
    const entries = {
      [paneKey('tab-i', '1')]: makeEntry({
        paneKey: paneKey('tab-i', '1'),
        state: 'working',
        stateStartedAt: NOW - 60_000,
        updatedAt: NOW - 1_000,
        stateHistory: [makeHistory('done', NOW - 5_000, true)]
      }),
      [paneKey('tab-f', '1')]: makeEntry({
        paneKey: paneKey('tab-f', '1'),
        state: 'working',
        stateStartedAt: NOW - 30_000,
        updatedAt: NOW - 1_000
      })
    }
    const sorted = sortSmart([onlyInterrupted, fresh], tabs, entries)
    // fresh has newer current stateStartedAt and onlyInterrupted's history is
    // skipped, so fresh wins on within-class recency.
    expect(sorted.map((w) => w.id)).toEqual(['fresh', 'only-interrupted'])
  })
})

describe('smart sort — interrupted and stale handling', () => {
  it('interrupted done worktrees fall to Class 4 (idle), not Class 2', () => {
    const interrupted = makeWorktree({
      id: 'interrupted',
      displayName: 'Interrupted',
      lastActivityAt: NOW - 60_000
    })
    const realDone = makeWorktree({ id: 'real-done', displayName: 'Real Done' })
    const tabs = {
      [interrupted.id]: [makeTab({ id: 'tab-i', worktreeId: interrupted.id })],
      [realDone.id]: [makeTab({ id: 'tab-d', worktreeId: realDone.id })]
    }
    const entries = {
      [paneKey('tab-i', '1')]: makeEntry({
        paneKey: paneKey('tab-i', '1'),
        state: 'done',
        interrupted: true,
        stateStartedAt: NOW - 1_000,
        updatedAt: NOW - 500
      }),
      [paneKey('tab-d', '1')]: makeEntry({
        paneKey: paneKey('tab-d', '1'),
        state: 'done',
        stateStartedAt: NOW - 5 * 60_000,
        updatedAt: NOW - 1_000
      })
    }
    const sorted = sortSmart([interrupted, realDone], tabs, entries)
    expect(sorted.map((w) => w.id)).toEqual(['real-done', 'interrupted'])
  })

  it('stale entries fall to Class 4', () => {
    const stale = makeWorktree({
      id: 'stale',
      displayName: 'Stale',
      lastActivityAt: NOW - 60_000
    })
    const fresh = makeWorktree({ id: 'fresh', displayName: 'Fresh' })
    const tabs = {
      [stale.id]: [makeTab({ id: 'tab-s', worktreeId: stale.id })],
      [fresh.id]: [makeTab({ id: 'tab-f', worktreeId: fresh.id })]
    }
    const entries = {
      [paneKey('tab-s', '1')]: makeEntry({
        paneKey: paneKey('tab-s', '1'),
        state: 'blocked',
        stateStartedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 60_000,
        updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 60_000
      }),
      [paneKey('tab-f', '1')]: makeEntry({
        paneKey: paneKey('tab-f', '1'),
        state: 'done',
        stateStartedAt: NOW - 5 * 60_000,
        updatedAt: NOW - 1_000
      })
    }
    const sorted = sortSmart([stale, fresh], tabs, entries)
    // fresh is Class 2; stale falls to Class 4.
    expect(sorted.map((w) => w.id)).toEqual(['fresh', 'stale'])
  })
})

describe('smart sort — Class 4 ordering', () => {
  it('breaks ties on effectiveRecentActivity, then displayName', () => {
    const recentlyActive = makeWorktree({
      id: 'recently-active',
      displayName: 'Z-Recent',
      lastActivityAt: NOW - 60_000
    })
    const lessRecentlyActive = makeWorktree({
      id: 'older',
      displayName: 'A-Older',
      lastActivityAt: NOW - 10 * 60_000
    })
    const tabs = {
      [recentlyActive.id]: [makeTab({ id: 'tab-r', worktreeId: recentlyActive.id })],
      [lessRecentlyActive.id]: [makeTab({ id: 'tab-o', worktreeId: lessRecentlyActive.id })]
    }
    const sorted = sortSmart([lessRecentlyActive, recentlyActive], tabs, {})
    // Both Class 4, recency wins despite alphabetical ordering being inverted.
    expect(sorted.map((w) => w.id)).toEqual(['recently-active', 'older'])
  })

  it('falls back to displayName when recency is identical', () => {
    const a = makeWorktree({
      id: 'a',
      displayName: 'A-First',
      lastActivityAt: NOW - 60_000
    })
    const b = makeWorktree({
      id: 'b',
      displayName: 'B-Second',
      lastActivityAt: NOW - 60_000
    })
    const tabs = {
      [a.id]: [makeTab({ id: 'tab-a', worktreeId: a.id })],
      [b.id]: [makeTab({ id: 'tab-b', worktreeId: b.id })]
    }
    const sorted = sortSmart([b, a], tabs, {})
    expect(sorted.map((w) => w.id)).toEqual(['a', 'b'])
  })

  it('honors the create-grace floor for new worktrees in Class 4', () => {
    const fresh = makeWorktree({
      id: 'fresh',
      displayName: 'Z-Fresh',
      createdAt: NOW,
      lastActivityAt: NOW
    })
    const bumped = makeWorktree({
      id: 'bumped',
      displayName: 'A-Bumped',
      lastActivityAt: NOW + 100
    })
    const tabs = {
      [fresh.id]: [makeTab({ id: 'tab-fresh', worktreeId: fresh.id })],
      [bumped.id]: [makeTab({ id: 'tab-bumped', worktreeId: bumped.id })]
    }
    const sorted = sortSmart([bumped, fresh], tabs, {})
    // Grace floor (createdAt + 5min) lifts fresh above the slightly-newer bump.
    expect(sorted.map((w) => w.id)).toEqual(['fresh', 'bumped'])
  })
})

describe('smart sort — multi-pane resolution', () => {
  it('any blocked pane promotes the whole worktree to Class 1', () => {
    const splitWorktree = makeWorktree({ id: 'split', displayName: 'Split' })
    const otherDone = makeWorktree({ id: 'other-done', displayName: 'OtherDone' })
    const tabs = {
      [splitWorktree.id]: [makeTab({ id: 'tab-split', worktreeId: splitWorktree.id })],
      [otherDone.id]: [makeTab({ id: 'tab-other', worktreeId: otherDone.id })]
    }
    const entries = {
      [paneKey('tab-split', '1')]: makeEntry({
        paneKey: paneKey('tab-split', '1'),
        state: 'working',
        stateStartedAt: NOW - 60_000,
        updatedAt: NOW - 1_000
      }),
      [paneKey('tab-split', '2')]: makeEntry({
        paneKey: paneKey('tab-split', '2'),
        state: 'blocked',
        stateStartedAt: NOW - 30_000,
        updatedAt: NOW - 1_000
      }),
      [paneKey('tab-other', '1')]: makeEntry({
        paneKey: paneKey('tab-other', '1'),
        state: 'done',
        stateStartedAt: NOW - 5_000,
        updatedAt: NOW - 1_000
      })
    }
    const sorted = sortSmart([otherDone, splitWorktree], tabs, entries)
    expect(sorted.map((w) => w.id)).toEqual(['split', 'other-done'])
  })
})

describe('sortWorktreesSmart — cold start fallback', () => {
  it('falls back to persisted sortOrder when no PTY is alive', () => {
    const a = makeWorktree({ id: 'a', displayName: 'A', sortOrder: 1 })
    const b = makeWorktree({ id: 'b', displayName: 'B', sortOrder: 2 })
    // No tabs, no PTYs — cold start path.
    const sorted = sortWorktreesSmart([a, b], {}, repoMap, {}, {}, {})
    // Higher sortOrder wins on cold start.
    expect(sorted.map((w) => w.id)).toEqual(['b', 'a'])
  })

  it('treats slept tabs (tab.ptyId without live entry) as cold start', () => {
    // Why: tab.ptyId is the wake-hint sessionId preserved under sleep — not a
    // liveness signal. With slept tabs but no live PTYs, sortWorktreesSmart
    // must fall back to persisted sortOrder.
    const a = makeWorktree({ id: 'a', sortOrder: 1, displayName: 'a' })
    const b = makeWorktree({ id: 'b', sortOrder: 2, displayName: 'b' })
    const tabsByWorktree = {
      [a.id]: [makeTab({ id: 'ta', worktreeId: a.id, ptyId: 'wake-hint' })]
    }
    // ptyIdsByTabId is empty — slept tab has wake-hint ptyId but no live entry.
    const sorted = sortWorktreesSmart([a, b], tabsByWorktree, repoMap, {}, {}, {})
    expect(sorted.map((w) => w.id)).toEqual(['b', 'a'])
  })

  it('uses the smart comparator once a PTY is alive', () => {
    const blocked = makeWorktree({ id: 'blocked', displayName: 'Blocked', sortOrder: 0 })
    const done = makeWorktree({ id: 'done', displayName: 'Done', sortOrder: 100 })
    const tabsByWorktree = {
      [blocked.id]: [makeTab({ id: 'tab-blocked', worktreeId: blocked.id })],
      [done.id]: [makeTab({ id: 'tab-done', worktreeId: done.id })]
    }
    const entries = {
      [paneKey('tab-blocked', '1')]: makeEntry({
        paneKey: paneKey('tab-blocked', '1'),
        state: 'blocked',
        stateStartedAt: NOW - 60_000,
        updatedAt: NOW - 1_000
      }),
      [paneKey('tab-done', '1')]: makeEntry({
        paneKey: paneKey('tab-done', '1'),
        state: 'done',
        stateStartedAt: NOW - 30_000,
        updatedAt: NOW - 1_000
      })
    }
    const sorted = sortWorktreesSmart(
      [done, blocked],
      tabsByWorktree,
      repoMap,
      entries,
      {},
      ptyMapForTabs(tabsByWorktree)
    )
    // Smart comparator wins over sortOrder because at least one PTY is live.
    expect(sorted.map((w) => w.id)).toEqual(['blocked', 'done'])
  })
})

describe('sortWorktreesSmart — palette caller regression', () => {
  // Why: WorktreeJumpPalette routes typed queries through sortWorktreesSmart.
  // This test pins that the palette path uses the class layer (not just the
  // recent-activity fallback) when threading agentStatusByPaneKey.
  it('palette ranks blocked above working when both flow through sortWorktreesSmart', () => {
    const blocked = makeWorktree({ id: 'blocked', displayName: 'A-Blocked' })
    const working = makeWorktree({ id: 'working', displayName: 'B-Working' })
    const tabsByWorktree = {
      [blocked.id]: [makeTab({ id: 'tab-blocked', worktreeId: blocked.id })],
      [working.id]: [makeTab({ id: 'tab-working', worktreeId: working.id })]
    }
    const agentStatusByPaneKey: Record<string, AgentStatusEntry> = {
      [paneKey('tab-blocked', '1')]: makeEntry({
        paneKey: paneKey('tab-blocked', '1'),
        state: 'blocked',
        stateStartedAt: NOW - 60_000,
        updatedAt: NOW - 1_000
      }),
      [paneKey('tab-working', '1')]: makeEntry({
        paneKey: paneKey('tab-working', '1'),
        state: 'working',
        // newer than the blocked one — would win on recency alone
        stateStartedAt: NOW - 1_000,
        updatedAt: NOW - 500
      })
    }
    const sorted = sortWorktreesSmart(
      [working, blocked],
      tabsByWorktree,
      repoMap,
      agentStatusByPaneKey,
      {},
      ptyMapForTabs(tabsByWorktree)
    )
    expect(sorted.map((w) => w.id)).toEqual(['blocked', 'working'])
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

    worktrees.sort(buildWorktreeComparator('recent', repoMap, NOW, new Map()))

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

    worktrees.sort(buildWorktreeComparator('recent', repoMap, NOW, new Map()))

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

    worktrees.sort(buildWorktreeComparator('recent', repoMap, NOW, new Map()))

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

    worktrees.sort(buildWorktreeComparator('recent', repoMap, NOW, new Map()))

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
    const createdAt = NOW - 3 * 60 * 1000
    const wt = makeWorktree({ id: 'used', createdAt, lastActivityAt: NOW - 60_000 })
    expect(effectiveRecentActivity(wt, NOW)).toBe(createdAt + CREATE_GRACE_MS)
  })

  it('returns lastActivityAt once the grace window has elapsed even when no other activity has occurred', () => {
    const createdAt = NOW - CREATE_GRACE_MS - 1
    const wt = makeWorktree({ id: 'untouched', createdAt, lastActivityAt: createdAt })
    expect(effectiveRecentActivity(wt, NOW)).toBe(createdAt)
  })
})

describe('buildWorktreeComparator — recent with createdAt grace window', () => {
  it('keeps a newly-created worktree on top even when another worktree bumps lastActivityAt', () => {
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

    worktrees.sort(buildWorktreeComparator('recent', repoMap, NOW, new Map()))

    expect(worktrees.map((w) => w.id)).toEqual(['new', 'bumped'])
  })

  it('falls through to normal recency once the grace window has elapsed', () => {
    const oldCreated = makeWorktree({
      id: 'old-created',
      displayName: 'Old created',
      createdAt: NOW - CREATE_GRACE_MS - 10_000,
      lastActivityAt: NOW - 30_000
    })
    const freshActivity = makeWorktree({
      id: 'fresh-activity',
      displayName: 'Fresh activity',
      lastActivityAt: NOW - 1000
    })
    const worktrees = [oldCreated, freshActivity]

    worktrees.sort(buildWorktreeComparator('recent', repoMap, NOW, new Map()))

    expect(worktrees.map((w) => w.id)).toEqual(['fresh-activity', 'old-created'])
  })

  it('does not disturb ranking for worktrees without createdAt', () => {
    const alpha = makeWorktree({ id: 'alpha', displayName: 'Alpha', lastActivityAt: 5000 })
    const bravo = makeWorktree({ id: 'bravo', displayName: 'Bravo', lastActivityAt: 10_000 })
    const worktrees = [alpha, bravo]

    worktrees.sort(buildWorktreeComparator('recent', repoMap, NOW, new Map()))

    expect(worktrees.map((w) => w.id)).toEqual(['bravo', 'alpha'])
  })
})
