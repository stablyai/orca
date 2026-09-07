import { describe, expect, it } from 'vitest'
import {
  orderRecentWorkspaceTabs,
  resolveRecentWorkspaceTabStatus,
  type RecentWorkspaceTabRow
} from './recent-workspace-tab-rows'
import type { TabPaneInputSources } from '@/components/sidebar/smart-attention'
import type { AgentStatusEntry, AgentStatusState } from '../../../shared/agent-status-types'

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

describe('orderRecentWorkspaceTabs', () => {
  it('orders individual tab visits across worktrees and hosts', () => {
    const rows = [
      row('old', { lastFocusedAt: NOW - 3 * 86400_000 }),
      row('recent', { lastFocusedAt: NOW - 60_000, worktreeHostId: 'ssh:builder' }),
      row('newest', { lastFocusedAt: NOW, worktreeId: 'folder:/project' })
    ]
    expect(orderRecentWorkspaceTabs({ rows })).toEqual(['newest', 'recent', 'old'])
  })

  it('keeps unknown and invalid visit times below visited tabs with stable ties', () => {
    const rows = [
      row('unknown'),
      row('nan', { lastFocusedAt: Number.NaN }),
      row('first', { lastFocusedAt: NOW }),
      row('infinite', { lastFocusedAt: Infinity }),
      row('second', { lastFocusedAt: NOW })
    ]
    expect(orderRecentWorkspaceTabs({ rows })).toEqual([
      'first',
      'second',
      'unknown',
      'nan',
      'infinite'
    ])
    expect(rows[0].id).toBe('unknown')
  })

  it('keeps duplicate ids on different hosts as separate occurrences', () => {
    const rows = [
      row('same', { occurrenceId: 'local', lastFocusedAt: NOW - 1 }),
      row('same', { occurrenceId: 'ssh', worktreeHostId: 'ssh:builder', lastFocusedAt: NOW })
    ]
    expect(orderRecentWorkspaceTabs({ rows })).toEqual(['ssh', 'local'])
  })

  it('retains permission badges without promoting an old permission title', () => {
    const old = row('old', {
      lastFocusedAt: NOW - 3 * 86400_000,
      terminalTab: { id: 'old', title: 'OMP - action required' }
    })
    const paneSources = sources([], { ptyIdsByTabId: { old: ['pty-1'] } })
    expect(resolveRecentWorkspaceTabStatus(old, paneSources, NOW)).toBe('permission')
    expect(
      orderRecentWorkspaceTabs({ rows: [old, row('recent', { lastFocusedAt: NOW })] })
    ).toEqual(['recent', 'old'])
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
