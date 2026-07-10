import { describe, expect, it } from 'vitest'
import { narrowRendererPerfMetrics } from './renderer-perf-metrics'

describe('renderer perf metrics narrowing', () => {
  it('rejects non-object payloads', () => {
    expect(narrowRendererPerfMetrics(null)).toBeNull()
    expect(narrowRendererPerfMetrics([])).toBeNull()
    expect(narrowRendererPerfMetrics('nope')).toBeNull()
  })

  it('clamps hostile numeric fields and defaults missing nested objects', () => {
    const metrics = narrowRendererPerfMetrics({
      domNodeCount: Number.POSITIVE_INFINITY,
      jsHeapUsedBytes: -42,
      // Why: a 4.3 GB heap limit is a legitimate value the leak diagnostics
      // must report un-clipped, not a hostile number to clamp.
      jsHeapLimitBytes: 4_300_000_000,
      terminalPanes: {
        totalMountedPaneCount: 1.9,
        worktrees: [
          {
            worktreeLabel: 'repo',
            worktreeKind: 'ssh',
            paneCount: Number.NaN,
            scrollbackRowsTotal: -1,
            panes: [
              {
                cols: 120.8,
                rows: -30,
                normalBufferRows: 10,
                altBufferRows: Number.POSITIVE_INFINITY,
                hasWebgl: true
              }
            ]
          }
        ]
      },
      browserPanes: {
        browserWebviewCount: 2,
        registeredBrowserGuestCount: -10
      },
      registries: {
        ptySerializerCount: 3,
        livePaneManagerCount: 4,
        browserWebviewCount: 5,
        registeredBrowserGuestCount: 6
      }
    })

    expect(metrics).toMatchObject({
      jsHeapUsedBytes: 0,
      jsHeapLimitBytes: 4_300_000_000,
      terminalPanes: {
        totalMountedPaneCount: 1,
        worktrees: [
          {
            worktreeLabel: 'repo',
            worktreeKind: 'ssh',
            paneCount: 0,
            scrollbackRowsTotal: 0,
            panes: [
              {
                cols: 120,
                rows: 0,
                normalBufferRows: 10,
                altBufferRows: 0,
                hasWebgl: true
              }
            ]
          }
        ]
      },
      browserPanes: {
        browserWebviewCount: 2,
        registeredBrowserGuestCount: 0
      }
    })
    expect(metrics).not.toHaveProperty('domNodeCount')
  })

  it('caps worktree and pane arrays and marks the snapshot truncated', () => {
    const panes = Array.from({ length: 150 }, () => ({
      cols: 80,
      rows: 24,
      normalBufferRows: 1000,
      altBufferRows: 24,
      hasWebgl: false
    }))
    const worktrees = Array.from({ length: 250 }, (_, index) => ({
      worktreeLabel: `repo-${index}-${'x'.repeat(120)}`,
      worktreeKind: index % 2 === 0 ? 'runtime' : 'unknown',
      paneCount: panes.length,
      scrollbackRowsTotal: 1,
      panes
    }))

    const metrics = narrowRendererPerfMetrics({
      terminalPanes: {
        totalMountedPaneCount: 999,
        worktrees
      },
      browserPanes: {},
      registries: {}
    })

    expect(metrics?.truncated).toBe(true)
    expect(metrics?.terminalPanes.worktrees).toHaveLength(200)
    expect(metrics?.terminalPanes.worktrees[0]?.panes).toHaveLength(100)
    expect(metrics?.terminalPanes.worktrees[0]?.worktreeLabel.length).toBeLessThanOrEqual(80)
    expect(metrics?.terminalPanes.worktrees[1]?.worktreeKind).toBe('other')
  })
})
