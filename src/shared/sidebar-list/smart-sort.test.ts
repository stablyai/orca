import { describe, expect, it } from 'vitest'
import type { Repo } from '../repo-types'
import type { TerminalTab } from '../terminal-tab-types'
import type { Worktree } from '../worktree/types'
import { buildWorktreeComparator, CREATE_GRACE_MS, sortWorktreesSmart } from './smart-sort'
import { buildAttentionByWorktree } from './smart-attention'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStateHistoryEntry,
  type AgentStatusEntry
} from '../agent-status-types'
import { makePaneKey } from '../stable-pane-id'

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
    worktreeId: overrides.worktreeId,
    tabId: overrides.tabId,
    terminalTitle: overrides.terminalTitle,
    stateHistory: overrides.stateHistory ?? [],
    interrupted: overrides.interrupted,
    mainAgent: overrides.mainAgent
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

function sortSmartAt(
  now: number,
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
    now
  )
  return [...worktrees].sort(buildWorktreeComparator('smart', repoMap, now, attention))
}

function sortSmart(
  worktrees: Worktree[],
  tabsByWorktree: Record<string, TerminalTab[]>,
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
): Worktree[] {
  return sortSmartAt(NOW, worktrees, tabsByWorktree, agentStatusByPaneKey)
}

describe('smart sort — class invariants', () => {
  it('ranks working above idle', () => {
    const working = makeWorktree({ id: 'working', displayName: 'Working' })
    const idle = makeWorktree({
      id: 'idle',
      displayName: 'Idle',
      // Give Idle enough recency to beat Working if the class layer regresses.
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

  it('ranks a failed turn above an idle worktree and a cancelled one below it', () => {
    const idle = makeWorktree({ id: 'idle', displayName: 'Idle', lastActivityAt: NOW - 10_000 })
    const failed = makeWorktree({ id: 'failed', displayName: 'Failed', lastActivityAt: 0 })
    const stopped = makeWorktree({ id: 'stopped', displayName: 'Stopped', lastActivityAt: 0 })
    const tabs = {
      [idle.id]: [makeTab({ id: 'tab-idle', worktreeId: idle.id })],
      [failed.id]: [makeTab({ id: 'tab-failed', worktreeId: failed.id })],
      [stopped.id]: [makeTab({ id: 'tab-stopped', worktreeId: stopped.id })]
    }
    const doneWith = (tabId: string, outcome: 'failure' | 'cancellation') =>
      makeEntry({
        paneKey: paneKey(tabId, '1'),
        state: 'done',
        mainAgent: { state: 'done', outcome, stateStartedAt: NOW - 60_000 },
        stateStartedAt: NOW - 60_000,
        updatedAt: NOW - 1_000
      })
    const entries = {
      [paneKey('tab-failed', '1')]: doneWith('tab-failed', 'failure'),
      [paneKey('tab-stopped', '1')]: doneWith('tab-stopped', 'cancellation')
    }
    const sorted = sortSmart([stopped, idle, failed], tabs, entries)
    expect(sorted.map((w) => w.id)).toEqual(['failed', 'idle', 'stopped'])
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
    // Fresh Done ranks in Class 2; stale-with-live-PTY decays to Class 4.
    expect(sorted.map((w) => w.id)).toEqual(['fresh', 'stale'])
  })
})

describe('smart sort — completed-agent eligibility clock', () => {
  // Captured regression (docs/smart-sort-agent-activity-findings.md): a `done` row whose
  // updatedAt was 3m04s newer than its completion outranked two live spinners.
  const SCREENSHOT_AT = new Date('2026-03-27T21:44:39.000Z').getTime()
  const at = (hhmmss: string): number => new Date(`2026-03-27T${hhmmss}.000Z`).getTime()

  function capturedFixture(workingUpdatedAt = at('21:44:30')) {
    const done = makeWorktree({ id: 'fix-linear-persistent', displayName: 'fix-linear-persistent' })
    const workingA = makeWorktree({ id: 'allow-editing', displayName: 'allow-editing' })
    const workingB = makeWorktree({ id: 'resume-terminal', displayName: 'resume-terminal' })
    const tabs = {
      [done.id]: [makeTab({ id: 'tab-done', worktreeId: done.id })],
      [workingA.id]: [makeTab({ id: 'tab-a', worktreeId: workingA.id })],
      [workingB.id]: [makeTab({ id: 'tab-b', worktreeId: workingB.id })]
    }
    const entries = {
      [paneKey('tab-done', '1')]: makeEntry({
        paneKey: paneKey('tab-done', '1'),
        state: 'done',
        stateStartedAt: at('21:12:09'),
        // Same-state `done` writes pushed updatedAt 3m04s past the completion.
        updatedAt: at('21:15:13')
      }),
      [paneKey('tab-a', '1')]: makeEntry({
        paneKey: paneKey('tab-a', '1'),
        state: 'working',
        stateStartedAt: workingUpdatedAt - 68_000,
        updatedAt: workingUpdatedAt
      }),
      [paneKey('tab-b', '1')]: makeEntry({
        paneKey: paneKey('tab-b', '1'),
        state: 'working',
        stateStartedAt: workingUpdatedAt - 145_000,
        updatedAt: workingUpdatedAt - 5_000
      })
    }
    return { worktrees: [done, workingA, workingB], tabs, entries }
  }

  it('ranks the two spinners above the 32-minute-old completion', () => {
    const { worktrees, tabs, entries } = capturedFixture()
    const sorted = sortSmartAt(SCREENSHOT_AT, worktrees, tabs, entries)
    expect(sorted.map((w) => w.id)).toEqual([
      'allow-editing',
      'resume-terminal',
      'fix-linear-persistent'
    ])
  })

  it('still ranks that completion above the spinners inside its own window', () => {
    const { worktrees, tabs, entries } = capturedFixture(at('21:39:50'))
    const sorted = sortSmartAt(at('21:40:00'), worktrees, tabs, entries)
    expect(sorted[0].id).toBe('fix-linear-persistent')
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
    // Both are Idle, so recency must beat alphabetical order.
    expect(sorted.map((w) => w.id)).toEqual(['recently-active', 'older'])
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
  it('uses fresh attributed agents before their headless tabs are mirrored', () => {
    const blocked = makeWorktree({ id: 'blocked', displayName: 'Blocked', sortOrder: 0 })
    const persistedFirst = makeWorktree({
      id: 'persisted-first',
      displayName: 'Persisted first',
      sortOrder: 100
    })
    const key = paneKey('headless-tab')
    const entries = {
      [key]: makeEntry({
        paneKey: key,
        worktreeId: blocked.id,
        tabId: 'headless-tab',
        state: 'blocked',
        stateStartedAt: Date.now() - 1_000,
        updatedAt: Date.now()
      })
    }

    const sorted = sortWorktreesSmart([persistedFirst, blocked], {}, repoMap, entries, {}, {})

    expect(sorted.map((worktree) => worktree.id)).toEqual(['blocked', 'persisted-first'])
  })

  it('uses a fresh agent resolved through its mirrored tab without a worktree stamp', () => {
    const blocked = makeWorktree({ id: 'blocked', displayName: 'Blocked', sortOrder: 0 })
    const persistedFirst = makeWorktree({
      id: 'persisted-first',
      displayName: 'Persisted first',
      sortOrder: 100
    })
    const key = paneKey('mirrored-tab')
    const tabsByWorktree = {
      [blocked.id]: [makeTab({ id: 'mirrored-tab', worktreeId: blocked.id })]
    }
    const entries = {
      [key]: makeEntry({
        paneKey: key,
        state: 'blocked',
        stateStartedAt: Date.now() - 1_000,
        updatedAt: Date.now()
      })
    }

    const sorted = sortWorktreesSmart(
      [persistedFirst, blocked],
      tabsByWorktree,
      repoMap,
      entries,
      {},
      {}
    )

    expect(sorted.map((worktree) => worktree.id)).toEqual(['blocked', 'persisted-first'])
  })

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

    const sorted = sortWorktreesSmart([named, missingDisplayName], {}, repoMap, {}, {}, {})

    expect(sorted.map((w) => w.id)).toEqual(['missing-display-name', 'named'])
  })

  it('treats slept tabs (tab.ptyId without live entry) as cold start', () => {
    // Slept tab.ptyId is a wake hint, not live evidence; empty live PTYs retain persisted cold-start order.
    const a = makeWorktree({ id: 'a', sortOrder: 1, displayName: 'a' })
    const b = makeWorktree({ id: 'b', sortOrder: 2, displayName: 'b' })
    const tabsByWorktree = {
      [a.id]: [makeTab({ id: 'ta', worktreeId: a.id, ptyId: 'wake-hint' })]
    }
    const sorted = sortWorktreesSmart([a, b], tabsByWorktree, repoMap, {}, {}, {})
    expect(sorted.map((w) => w.id)).toEqual(['b', 'a'])
  })
})

describe('buildWorktreeComparator — recent (lastActivityAt)', () => {
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

describe('buildWorktreeComparator — manual order', () => {
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

    worktrees.sort(buildWorktreeComparator('manual', repoMap, NOW, new Map()))

    expect(worktrees.map((w) => w.id)).toEqual(['restored-top', 'restored-bottom'])
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
})
