import { describe, expect, it } from 'vitest'
import {
  summarizeLatencySamples,
  summarizeTypingScaleCensus,
  summarizeWorktreeNesting
} from './typing-latency-diagnostic-summary'

describe('summarizeLatencySamples', () => {
  it('reports null percentiles with no samples', () => {
    expect(summarizeLatencySamples([])).toEqual({ count: 0, p50: null, p95: null, max: null })
  })

  it('computes nearest-rank percentiles and max', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1)
    expect(summarizeLatencySamples(values)).toEqual({ count: 100, p50: 50, p95: 95, max: 100 })
  })

  it('rounds to two decimals and ignores non-finite samples', () => {
    const summary = summarizeLatencySamples([
      1.23456,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      9.87654
    ])
    expect(summary).toEqual({ count: 2, p50: 1.23, p95: 9.88, max: 9.88 })
  })

  it('handles a single sample', () => {
    expect(summarizeLatencySamples([42])).toEqual({ count: 1, p50: 42, p95: 42, max: 42 })
  })
})

describe('summarizeWorktreeNesting', () => {
  it('returns zero depth for flat sibling worktrees', () => {
    expect(summarizeWorktreeNesting(['/a/one', '/a/two'])).toEqual({
      maxDepth: 0,
      nestedWorktrees: 0
    })
  })

  it('counts nesting depth for worktrees inside worktrees', () => {
    expect(
      summarizeWorktreeNesting(['/repo', '/repo/wt-a', '/repo/wt-a/wt-b', '/repo/wt-a/wt-b/wt-c'])
    ).toEqual({ maxDepth: 3, nestedWorktrees: 3 })
  })

  it('normalizes windows separators, case, and trailing slashes', () => {
    expect(summarizeWorktreeNesting(['C:\\Repo\\', 'c:/repo/Nested'])).toEqual({
      maxDepth: 1,
      nestedWorktrees: 1
    })
  })

  it('ignores prefix matches that are not path boundaries', () => {
    expect(summarizeWorktreeNesting(['/repo', '/repo-two'])).toEqual({
      maxDepth: 0,
      nestedWorktrees: 0
    })
  })

  it('tolerates empty and duplicate entries', () => {
    expect(summarizeWorktreeNesting(['', '/a', '/a'])).toEqual({ maxDepth: 0, nestedWorktrees: 0 })
  })
})

describe('summarizeTypingScaleCensus', () => {
  const focusedPane = {
    paneId: 3,
    leafId: 'leaf-3',
    bufferType: 'alternate' as const,
    cols: 120,
    rows: 40,
    bufferLines: 5000,
    foregroundAgent: 'codex',
    statusAgentType: 'codex'
  }

  it('aggregates agent rows, tabs, panes, nesting, and suspect settings', () => {
    const census = summarizeTypingScaleCensus({
      state: {
        worktreesByRepo: {
          repoA: [{ path: '/repo-a' }, { path: '/repo-a/nested' }],
          repoB: [{ path: '/repo-b' }]
        },
        tabsByWorktree: { wt1: [{}, {}], wt2: [{}] },
        unifiedTabsByWorktree: { wt1: [{}] },
        agentStatusByPaneKey: { 'tab:leaf-1': {}, 'tab:leaf-2': {} },
        retainedAgentsByPaneKey: { 'tab:leaf-3': {} },
        activeTabId: 'tab',
        activeTabType: 'terminal',
        settings: {
          tabAutoGenerateTitle: true,
          compactWorktreeCards: false,
          agentActivityDisplayMode: 'compact',
          terminalScrollbackRows: 10_000,
          terminalGpuAcceleration: 'auto'
        }
      },
      appVersion: '1.4.156',
      livePaneCount: 4,
      instrumentedPaneCount: 4,
      mountedAgentRowCount: 7,
      storeListenerCount: 312,
      focusedPane
    })

    expect(census.appVersion).toBe('1.4.156')
    expect(census.repos).toBe(2)
    expect(census.worktrees).toBe(3)
    expect(census.worktreeNesting).toEqual({ maxDepth: 1, nestedWorktrees: 1 })
    expect(census.tabs).toEqual({ terminal: 3, unified: 1 })
    expect(census.panes).toEqual({ live: 4, instrumented: 4 })
    expect(census.agentRows).toEqual({
      storeLive: 2,
      storeRetained: 1,
      storeTotal: 3,
      mountedDom: 7
    })
    expect(census.storeListeners).toBe(312)
    expect(census.settings.tabAutoGenerateTitle).toBe(true)
    expect(census.settings.terminalScrollbackRows).toBe(10_000)
    expect(census.activeTab).toEqual({ id: 'tab', type: 'terminal' })
    expect(census.focusedPane).toEqual(focusedPane)
  })

  it('emits nulls instead of throwing when the store is unavailable', () => {
    const census = summarizeTypingScaleCensus({
      state: null,
      appVersion: null,
      livePaneCount: null,
      instrumentedPaneCount: 0,
      mountedAgentRowCount: null,
      storeListenerCount: null,
      focusedPane: null
    })

    expect(census).toEqual({
      appVersion: null,
      repos: 0,
      worktrees: 0,
      worktreeNesting: { maxDepth: 0, nestedWorktrees: 0 },
      tabs: { terminal: 0, unified: 0 },
      panes: { live: null, instrumented: 0 },
      agentRows: { storeLive: 0, storeRetained: 0, storeTotal: 0, mountedDom: null },
      storeListeners: null,
      settings: {
        tabAutoGenerateTitle: null,
        compactWorktreeCards: null,
        agentActivityDisplayMode: null,
        terminalScrollbackRows: null,
        terminalGpuAcceleration: null
      },
      activeTab: { id: null, type: null },
      focusedPane: null
    })
  })

  it('reports nulls for settings of unexpected types rather than coercing', () => {
    const census = summarizeTypingScaleCensus({
      state: {
        settings: {
          tabAutoGenerateTitle: 'yes',
          terminalScrollbackRows: Number.NaN,
          terminalGpuAcceleration: 42
        }
      },
      appVersion: null,
      livePaneCount: 1,
      instrumentedPaneCount: 1,
      mountedAgentRowCount: 0,
      storeListenerCount: 0,
      focusedPane: null
    })

    expect(census.settings.tabAutoGenerateTitle).toBeNull()
    expect(census.settings.terminalScrollbackRows).toBeNull()
    expect(census.settings.terminalGpuAcceleration).toBeNull()
  })

  it('tolerates malformed per-worktree collections', () => {
    const census = summarizeTypingScaleCensus({
      state: {
        worktreesByRepo: { repoA: [{ path: null }, {}] as never },
        tabsByWorktree: { wt1: null as never },
        unifiedTabsByWorktree: undefined,
        settings: null
      },
      appVersion: null,
      livePaneCount: null,
      instrumentedPaneCount: 0,
      mountedAgentRowCount: null,
      storeListenerCount: null,
      focusedPane: null
    })

    expect(census.worktrees).toBe(0)
    expect(census.tabs).toEqual({ terminal: 0, unified: 0 })
  })
})
