import { describe, expect, it } from 'vitest'
import {
  buildFocusedGroupTabRecency,
  focusedGroupTabKey,
  orderRecentWorkspaceTabs,
  resolveRecentWorkspaceTabStatus,
  type RecentWorkspaceTabRow
} from './recent-workspace-tab-rows'
import type { TabPaneInputSources } from '@/components/sidebar/smart-attention'
import type { AgentStatusEntry, AgentStatusState } from '../../../shared/agent-status-types'
import type { TabGroup } from '../../../shared/tab-types'

const NOW = 1_700_000_000_000
const LEAF_ID = '11111111-2222-4333-8444-555555555555'

function entry(
  tabId: string,
  state: AgentStatusState,
  stateStartedAt: number,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: stateStartedAt,
    stateStartedAt,
    paneKey: `${tabId}:${LEAF_ID}`,
    stateHistory: [],
    ...overrides
  }
}

function row(id: string, overrides: Partial<RecentWorkspaceTabRow> = {}): RecentWorkspaceTabRow {
  return {
    id,
    worktreeId: `wt-${id}`,
    unifiedTabId: `unified-${id}`,
    terminalTab: { id, title: 'zsh' },
    worktreeLastActivityAt: 0,
    ...overrides
  }
}

function sources(
  entries: AgentStatusEntry[],
  overrides: Partial<TabPaneInputSources> = {}
): TabPaneInputSources {
  const entriesByTabId = new Map<string, AgentStatusEntry[]>()
  for (const item of entries) {
    const tabId = item.paneKey.split(':')[0]
    entriesByTabId.set(tabId, [...(entriesByTabId.get(tabId) ?? []), item])
  }
  return {
    entriesByTabId,
    ptyIdsByTabId: {},
    runtimePaneTitlesByTabId: {},
    terminalLayoutsByTabId: {},
    ...overrides
  }
}

function order(
  rows: RecentWorkspaceTabRow[],
  paneSources: TabPaneInputSources,
  overrides: {
    lastVisitedAtByWorktreeId?: Record<string, number>
    focusedGroupTabRecency?: Map<string, number>
  } = {}
): string[] {
  return orderRecentWorkspaceTabs({
    rows,
    paneSources,
    now: NOW,
    lastVisitedAtByWorktreeId: overrides.lastVisitedAtByWorktreeId ?? {},
    focusedGroupTabRecency: overrides.focusedGroupTabRecency ?? new Map()
  })
}

describe('orderRecentWorkspaceTabs', () => {
  it('puts blocked agents above freshly finished ones, whatever their timestamps', () => {
    const rows = [row('done'), row('blocked')]
    const paneSources = sources([
      entry('done', 'done', NOW - 1_000),
      entry('blocked', 'blocked', NOW - 600_000)
    ])

    expect(order(rows, paneSources)).toEqual(['blocked', 'done'])
  })

  it('orders within a tier by attention timestamp, newest first', () => {
    const rows = [row('older'), row('newer')]
    const paneSources = sources([
      entry('older', 'waiting', NOW - 500_000),
      entry('newer', 'waiting', NOW - 1_000)
    ])

    expect(order(rows, paneSources)).toEqual(['newer', 'older'])
  })

  it('demotes an interrupted done below a live blocked row', () => {
    const rows = [row('interrupted'), row('blocked')]
    const paneSources = sources([
      entry('interrupted', 'done', NOW - 1_000, { interrupted: true }),
      entry('blocked', 'blocked', NOW - 900_000)
    ])

    expect(order(rows, paneSources)).toEqual(['blocked', 'interrupted'])
  })

  it('drops a stale done out of the attention tier after the freshness window', () => {
    const rows = [row('stale'), row('visited')]
    const paneSources = sources([entry('stale', 'done', NOW - 40 * 60_000)])

    expect(
      order(rows, paneSources, {
        lastVisitedAtByWorktreeId: { 'wt-visited': NOW - 1_000 }
      })
    ).toEqual(['visited', 'stale'])
  })

  it('ranks non-attention rows by worktree focus recency', () => {
    const rows = [row('cold'), row('warm')]

    expect(
      order(rows, sources([]), {
        lastVisitedAtByWorktreeId: {
          'wt-cold': NOW - 900_000,
          'wt-warm': NOW - 1_000
        }
      })
    ).toEqual(['warm', 'cold'])
  })

  it('uses host-qualified recency for same-id worktree rows', () => {
    const rows = [
      row('local', { worktreeId: 'repo::/app', worktreeHostId: 'local' }),
      row('ssh', { worktreeId: 'repo::/app', worktreeHostId: 'ssh:builder' })
    ]

    expect(
      order(rows, sources([]), {
        lastVisitedAtByWorktreeId: {
          'local|repo::/app': NOW - 1_000,
          'ssh:builder|repo::/app': NOW
        }
      })
    ).toEqual(['ssh', 'local'])
  })

  it('prefers any visited worktree over a never-visited one', () => {
    const rows = [row('never'), row('ancient')]

    expect(
      order(rows, sources([]), {
        lastVisitedAtByWorktreeId: { 'wt-ancient': 1 }
      })
    ).toEqual(['ancient', 'never'])
  })

  it('breaks a same-worktree tie with the focused group MRU tail', () => {
    const rows = [
      row('first', { worktreeId: 'wt-1' }),
      row('second', { worktreeId: 'wt-1' }),
      row('third', { worktreeId: 'wt-1' })
    ]

    expect(
      order(rows, sources([]), {
        lastVisitedAtByWorktreeId: { 'wt-1': NOW },
        focusedGroupTabRecency: new Map([
          [focusedGroupTabKey('wt-1', 'unified-first'), 0],
          [focusedGroupTabKey('wt-1', 'unified-third'), 1],
          [focusedGroupTabKey('wt-1', 'unified-second'), 2]
        ])
      })
    ).toEqual(['second', 'third', 'first'])
  })

  it('keeps input order across worktrees instead of comparing their unrelated MRU ordinals', () => {
    // Callers pass worktree-grouped positional order; both worktrees are never-visited, so only
    // the per-worktree focus ordinals differ — beta's larger ordinal must not hoist it over alpha.
    const rows = [
      row('alpha-1', { worktreeId: 'wt-alpha', unifiedTabId: 'unified-alpha-1' }),
      row('alpha-2', { worktreeId: 'wt-alpha', unifiedTabId: 'unified-alpha-2' }),
      row('beta-1', { worktreeId: 'wt-beta', unifiedTabId: 'unified-beta-1' })
    ]

    expect(
      order(rows, sources([]), {
        focusedGroupTabRecency: new Map([
          [focusedGroupTabKey('wt-alpha', 'unified-alpha-1'), 0],
          [focusedGroupTabKey('wt-alpha', 'unified-alpha-2'), 1],
          [focusedGroupTabKey('wt-beta', 'unified-beta-1'), 5]
        ])
      })
    ).toEqual(['alpha-2', 'alpha-1', 'beta-1'])
  })

  it('keeps an interleaved worktree block together before applying its focused-group MRU', () => {
    const rows = [
      row('alpha-old', { worktreeId: 'wt-alpha', unifiedTabId: 'unified-alpha-old' }),
      row('beta', { worktreeId: 'wt-beta', unifiedTabId: 'unified-beta' }),
      row('alpha-new', { worktreeId: 'wt-alpha', unifiedTabId: 'unified-alpha-new' })
    ]

    expect(
      order(rows, sources([]), {
        focusedGroupTabRecency: new Map([
          [focusedGroupTabKey('wt-alpha', 'unified-alpha-old'), 0],
          [focusedGroupTabKey('wt-alpha', 'unified-alpha-new'), 1],
          [focusedGroupTabKey('wt-beta', 'unified-beta'), 0]
        ])
      })
    ).toEqual(['alpha-new', 'alpha-old', 'beta'])
  })

  it('keeps duplicate tab ids in separate worktrees on their own MRU ordinals', () => {
    const rows = [
      row('alpha-1', { worktreeId: 'wt-alpha', unifiedTabId: 'shared-tab' }),
      row('alpha-2', { worktreeId: 'wt-alpha', unifiedTabId: 'alpha-only' }),
      row('beta', { worktreeId: 'wt-beta', unifiedTabId: 'shared-tab' })
    ]

    expect(
      order(rows, sources([]), {
        lastVisitedAtByWorktreeId: { 'wt-alpha': NOW, 'wt-beta': NOW - 1 },
        focusedGroupTabRecency: new Map([
          [focusedGroupTabKey('wt-alpha', 'shared-tab'), 0],
          [focusedGroupTabKey('wt-alpha', 'alpha-only'), 1],
          // Beta's ordinal for the same tab id must not hoist alpha's occurrence.
          [focusedGroupTabKey('wt-beta', 'shared-tab'), 9]
        ])
      })
    ).toEqual(['alpha-2', 'alpha-1', 'beta'])
  })

  it('keeps same-id worktrees on two hosts in separate order blocks', () => {
    const rows = [
      row('local-old', { worktreeId: 'wt-1', worktreeHostId: 'local', unifiedTabId: 'local-old' }),
      row('ssh', { worktreeId: 'wt-1', worktreeHostId: 'ssh:box', unifiedTabId: 'ssh' }),
      row('local-new', { worktreeId: 'wt-1', worktreeHostId: 'local', unifiedTabId: 'local-new' })
    ]

    expect(
      order(rows, sources([]), {
        focusedGroupTabRecency: new Map([
          [focusedGroupTabKey('wt-1', 'local-old'), 0],
          [focusedGroupTabKey('wt-1', 'local-new'), 1],
          [focusedGroupTabKey('wt-1', 'ssh'), 5]
        ])
      })
    ).toEqual(['local-new', 'local-old', 'ssh'])
  })

  it('keeps input (positional) order when nothing else separates two rows', () => {
    const rows = [row('a', { worktreeId: 'wt-1' }), row('b', { worktreeId: 'wt-1' })]

    expect(order(rows, sources([]), { lastVisitedAtByWorktreeId: { 'wt-1': NOW } })).toEqual([
      'a',
      'b'
    ])
  })

  it('returns each occurrence identity when palette ids collide', () => {
    const rows = [
      row('workspace-tab:duplicate', {
        occurrenceId: 'recent-tab:alpha',
        worktreeId: 'wt-alpha'
      }),
      row('workspace-tab:duplicate', {
        occurrenceId: 'recent-tab:beta',
        worktreeId: 'wt-beta'
      })
    ]

    expect(order(rows, sources([]))).toEqual(['recent-tab:alpha', 'recent-tab:beta'])
  })

  it('treats rows without a terminal tab as idle', () => {
    const rows = [row('browser', { terminalTab: null, unifiedTabId: null }), row('blocked')]

    expect(order(rows, sources([entry('blocked', 'blocked', NOW)]))).toEqual(['blocked', 'browser'])
  })

  it('promotes a hookless pane whose live title reads as a permission prompt', () => {
    const rows = [
      row('titled', {
        terminalTab: { id: 'titled', title: 'OMP - action required' }
      })
    ]
    const paneSources = sources([], {
      ptyIdsByTabId: { titled: ['pty-1'] },
      runtimePaneTitlesByTabId: { titled: { 1: 'OMP - action required' } }
    })

    expect(order(rows, paneSources)).toEqual(['titled'])
    expect(resolveRecentWorkspaceTabStatus(rows[0], paneSources, NOW)).toBe('permission')
  })

  it('does not let a slept tab leak its stale title into the ranking', () => {
    const rows = [
      row('slept', {
        terminalTab: { id: 'slept', title: 'OMP - action required' }
      })
    ]
    const paneSources = sources([], {
      runtimePaneTitlesByTabId: { slept: { 1: 'OMP - action required' } }
    })

    expect(resolveRecentWorkspaceTabStatus(rows[0], paneSources, NOW)).toBe('inactive')
  })
})

describe('resolveRecentWorkspaceTabStatus', () => {
  it('surfaces an interrupted outcome without promoting its sort class', () => {
    const interrupted = entry('interrupted', 'done', NOW - 1_000, { interrupted: true })

    expect(resolveRecentWorkspaceTabStatus(row('interrupted'), sources([interrupted]), NOW)).toBe(
      'interrupted'
    )
  })

  it('does not let a cleanly finished sibling mask an interruption', () => {
    const interrupted = entry('mixed', 'done', NOW - 1_000, {
      paneKey: `mixed:${LEAF_ID}`,
      interrupted: true
    })
    const finished = entry('mixed', 'done', NOW - 2_000, {
      paneKey: 'mixed:22222222-2222-4222-8222-222222222222'
    })

    expect(
      resolveRecentWorkspaceTabStatus(row('mixed'), sources([interrupted, finished]), NOW)
    ).toBe('interrupted')
  })
  it('maps attention classes onto the sidebar dot vocabulary', () => {
    const blocked = row('blocked')
    const done = row('done')
    const working = row('working')

    expect(
      resolveRecentWorkspaceTabStatus(blocked, sources([entry('blocked', 'blocked', NOW)]), NOW)
    ).toBe('permission')
    expect(resolveRecentWorkspaceTabStatus(done, sources([entry('done', 'done', NOW)]), NOW)).toBe(
      'done'
    )
    expect(
      resolveRecentWorkspaceTabStatus(working, sources([entry('working', 'working', NOW)]), NOW)
    ).toBe('working')
  })

  it('preserves monitoring unless another pane is actively working', () => {
    const monitoring = row('monitoring')
    const monitoringEntry = entry('monitoring', 'working', NOW, {
      workingMode: 'monitoring'
    })

    expect(resolveRecentWorkspaceTabStatus(monitoring, sources([monitoringEntry]), NOW)).toBe(
      'monitoring'
    )
    expect(
      resolveRecentWorkspaceTabStatus(
        monitoring,
        sources([
          monitoringEntry,
          entry('monitoring', 'working', NOW, {
            paneKey: 'monitoring:22222222-3333-4444-8555-666666666666'
          })
        ]),
        NOW
      )
    ).toBe('working')
  })

  it('falls back to live-pty presence for idle rows', () => {
    const live = row('live')

    expect(
      resolveRecentWorkspaceTabStatus(
        live,
        sources([], { ptyIdsByTabId: { live: ['pty-1'] } }),
        NOW
      )
    ).toBe('active')
    expect(resolveRecentWorkspaceTabStatus(live, sources([]), NOW)).toBe('inactive')
  })
})

describe('buildFocusedGroupTabRecency', () => {
  function group(id: string, recentTabIds: string[]): TabGroup {
    return {
      id,
      worktreeId: 'wt-1',
      activeTabId: recentTabIds.at(-1) ?? null,
      tabOrder: recentTabIds,
      recentTabIds
    }
  }

  it('indexes only the focused group of each worktree', () => {
    const recency = buildFocusedGroupTabRecency(
      { 'wt-1': 'group-a' },
      { 'wt-1': [group('group-a', ['t1', 't2']), group('group-b', ['t3'])] }
    )

    expect([...recency]).toEqual([
      [focusedGroupTabKey('wt-1', 't1'), 0],
      [focusedGroupTabKey('wt-1', 't2'), 1]
    ])
  })

  it('skips worktrees with no focused group', () => {
    expect(buildFocusedGroupTabRecency({}, { 'wt-1': [group('group-a', ['t1'])] }).size).toBe(0)
  })
})
