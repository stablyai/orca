// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { collectRendererPerfSnapshot } from './renderer-perf-snapshot'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn()
  }
}))

vi.mock('@/runtime/sync-runtime-graph', () => ({
  listRegisteredTerminalTabPerfSources: () => []
}))

vi.mock('@/components/browser-pane/webview-registry', () => ({
  getBrowserWebviewMemoryProfile: () => ({
    browserWebviewCount: 0,
    registeredBrowserGuestCount: 0
  })
}))

vi.mock('@/components/terminal-pane/pty-buffer-serializer', () => ({
  getRegisteredPtySerializerCount: () => 0
}))

vi.mock('@/lib/pane-manager/pane-manager-registry', () => ({
  getLivePaneManagerCount: () => 0
}))

describe('collectRendererPerfSnapshot', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main><section><button>Run</button></section></main>'
    Object.defineProperty(window.performance, 'memory', {
      configurable: true,
      value: {
        usedJSHeapSize: 1024,
        totalJSHeapSize: 2048,
        jsHeapSizeLimit: 4096
      }
    })
  })

  it('collects DOM, browser, registry, and terminal pane metrics on demand', () => {
    const metrics = collectRendererPerfSnapshot({
      getAppState: () => localState(),
      getBrowserProfile: () => ({
        browserWebviewCount: 2,
        registeredBrowserGuestCount: 1
      }),
      getPtySerializerCount: () => 3,
      getLiveManagerCount: () => 4,
      listTabSources: () => [
        {
          worktreeId: 'repo-1::/Users/orca/project-alpha',
          getManager: () => managerWithPane()
        }
      ]
    })

    expect(metrics.domNodeCount).toBe(document.getElementsByTagName('*').length)
    expect(metrics.jsHeapUsedBytes).toBe(1024)
    expect(metrics.browserPanes).toEqual({
      browserWebviewCount: 2,
      registeredBrowserGuestCount: 1
    })
    expect(metrics.registries).toEqual({
      ptySerializerCount: 3,
      livePaneManagerCount: 4,
      browserWebviewCount: 2,
      registeredBrowserGuestCount: 1
    })
    expect(metrics.terminalPanes).toEqual({
      totalMountedPaneCount: 1,
      worktrees: [
        {
          worktreeLabel: 'project-alpha',
          worktreeKind: 'local',
          paneCount: 1,
          scrollbackRowsTotal: 124,
          panes: [
            {
              cols: 120,
              rows: 30,
              normalBufferRows: 100,
              altBufferRows: 24,
              hasWebgl: true
            }
          ]
        }
      ]
    })
  })

  it('skips throwing and disposed tab sources without failing the snapshot', () => {
    const metrics = collectRendererPerfSnapshot({
      getAppState: () => localState(),
      listTabSources: () => [
        {
          worktreeId: 'repo-1::/Users/orca/project-alpha',
          getManager: () => {
            throw new Error('unmounting')
          }
        },
        {
          worktreeId: 'repo-1::/Users/orca/project-alpha',
          getManager: () => null
        },
        {
          worktreeId: 'global-floating-terminal',
          getManager: () => managerWithPane()
        }
      ]
    })

    expect(metrics.terminalPanes.totalMountedPaneCount).toBe(1)
    expect(metrics.terminalPanes.worktrees[0]?.worktreeLabel).toBe('floating')
    expect(metrics.terminalPanes.worktrees[0]?.worktreeKind).toBe('floating')
  })

  it('caps per-worktree pane detail before IPC while keeping totals accurate', () => {
    const manyPanes = Array.from({ length: 60 }, (_, index) => ({
      id: index,
      terminal: {
        cols: 80,
        rows: 24,
        buffer: { normal: { length: 10 }, alternate: { length: 0 } }
      }
    }))
    const manager = {
      getPanes: () => manyPanes,
      getRenderingDiagnostics: () => []
    } as never
    const source = { worktreeId: 'repo-1::/Users/orca/project-alpha', getManager: () => manager }

    const metrics = collectRendererPerfSnapshot({
      getAppState: () => localState(),
      listTabSources: () => [source, source, source]
    })

    const worktree = metrics.terminalPanes.worktrees[0]
    expect(metrics.terminalPanes.totalMountedPaneCount).toBe(180)
    expect(worktree?.paneCount).toBe(180)
    expect(worktree?.scrollbackRowsTotal).toBe(1800)
    expect(worktree?.panes).toHaveLength(100)
  })
})

function managerWithPane() {
  return {
    getPanes: () => [
      {
        id: 7,
        terminal: {
          cols: 120,
          rows: 30,
          buffer: {
            normal: { length: 100 },
            alternate: { length: 24 }
          }
        }
      }
    ],
    getRenderingDiagnostics: () => [
      {
        paneId: 7,
        hasWebgl: true
      }
    ]
  } as never
}

function localState() {
  return {
    repos: [{ id: 'repo-1', connectionId: null }],
    worktreesByRepo: {
      'repo-1': [{ id: 'repo-1::/Users/orca/project-alpha', repoId: 'repo-1' }]
    },
    folderWorkspaces: [],
    projectGroups: []
  } as never
}
