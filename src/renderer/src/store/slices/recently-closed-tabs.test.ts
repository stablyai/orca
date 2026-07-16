/**
 * Cmd/Ctrl+Shift+T reopen behavior: terminal tabs join the recently-closed
 * stacks, and the unified dispatcher pops the most recently closed tab of any
 * kind (terminal/browser/editor) in true cross-type MRU order.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultSettings } from '../../../../shared/constants'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = {
  worktrees: {
    list: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(undefined),
    updateMeta: vi.fn().mockResolvedValue({})
  },
  pty: { kill: vi.fn().mockResolvedValue(undefined) },
  runtimeEnvironments: { call: vi.fn().mockResolvedValue({ ok: true, result: {} }) }
}

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

import { createTestStore, seedStore, makeWorktree, makeOpenFile } from './store-test-helpers'
import {
  pushRecentlyClosedTabKind,
  remapClosedTerminalTabSnapshotCwds
} from './recently-closed-tabs'

const WT = 'repo1::/path/wt1'

function makeSeededStore(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })]
    },
    activeWorktreeId: WT
  })
  return store
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('terminal recently-closed capture', () => {
  it('captures a snapshot and kind entry on user close', () => {
    const store = makeSeededStore()
    const tab = store
      .getState()
      .createTab(WT, undefined, undefined, { startupCwd: '/path/wt1/packages/app' })
    store.getState().setTabCustomTitle(tab.id, 'build shell')
    store.getState().setTabColor(tab.id, '#ff0000')

    store.getState().closeTab(tab.id)

    expect(store.getState().recentlyClosedTerminalTabsByWorktree[WT]).toEqual([
      { startupCwd: '/path/wt1/packages/app', customTitle: 'build shell', color: '#ff0000' }
    ])
    expect(store.getState().recentlyClosedTabKindsByWorktree[WT]).toEqual(['terminal'])
  })

  it.each(['cleanup', 'pty-exit'] as const)('skips capture for %s closes', (reason) => {
    const store = makeSeededStore()
    const tab = store.getState().createTab(WT)

    store.getState().closeTab(tab.id, { reason })

    expect(store.getState().recentlyClosedTerminalTabsByWorktree[WT]).toBeUndefined()
    expect(store.getState().recentlyClosedTabKindsByWorktree[WT]).toBeUndefined()
  })

  it('skips capture for a confirmed parked PTY exit', () => {
    const store = makeSeededStore()
    const tab = store.getState().createTab(WT)

    store.getState().closeTab(tab.id, { captureRecentlyClosed: false })

    expect(store.getState().recentlyClosedTerminalTabsByWorktree[WT]).toBeUndefined()
    expect(store.getState().recentlyClosedTabKindsByWorktree[WT]).toBeUndefined()
  })

  it('caps the terminal stack at 10 snapshots, newest first', () => {
    const store = makeSeededStore()
    for (let i = 0; i < 12; i++) {
      const tab = store
        .getState()
        .createTab(WT, undefined, undefined, { startupCwd: `/path/wt1/dir-${i}` })
      store.getState().closeTab(tab.id)
    }

    const stack = store.getState().recentlyClosedTerminalTabsByWorktree[WT]
    expect(stack).toHaveLength(10)
    expect(stack[0]?.startupCwd).toBe('/path/wt1/dir-11')
    expect(stack[9]?.startupCwd).toBe('/path/wt1/dir-2')
  })
})

describe('recently-closed history bounds', () => {
  it('caps the bulk kind allocation before constructing it', () => {
    const result = pushRecentlyClosedTabKind({}, WT, 'editor', Number.MAX_SAFE_INTEGER)

    expect(result[WT]).toHaveLength(30)
    expect(result[WT]?.every((kind) => kind === 'editor')).toBe(true)
  })
})

describe('terminal snapshot cwd remapping', () => {
  it('handles case-insensitive Windows roots and preserves the new separator style', () => {
    expect(
      remapClosedTerminalTabSnapshotCwds(
        [{ startupCwd: 'c:\\REPO\\old\\packages\\app' }],
        'C:\\Repo\\Old\\',
        'D:\\Worktrees\\New'
      )
    ).toEqual([{ startupCwd: 'D:\\Worktrees\\New\\packages\\app' }])
  })

  it('does not treat a POSIX backslash as a directory separator', () => {
    const snapshot = { startupCwd: '/repo/old\\sibling' }

    expect(remapClosedTerminalTabSnapshotCwds([snapshot], '/repo/old', '/repo/new')).toEqual([
      snapshot
    ])
  })
})

describe('reopenClosedTerminalTab', () => {
  it('recreates a fresh terminal with the snapshot cwd, shell, title, and color', () => {
    const store = makeSeededStore()
    const tab = store
      .getState()
      .createTab(WT, undefined, 'zsh', { startupCwd: '/path/wt1/packages/app' })
    store.getState().setTabCustomTitle(tab.id, 'build shell')
    store.getState().setTabColor(tab.id, '#ff0000')
    store.getState().closeTab(tab.id)
    expect(store.getState().tabsByWorktree[WT]).toHaveLength(0)

    expect(store.getState().reopenClosedTerminalTab(WT)).toBe(true)

    const restored = store.getState().tabsByWorktree[WT]
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({
      startupCwd: '/path/wt1/packages/app',
      shellOverride: 'zsh',
      customTitle: 'build shell',
      color: '#ff0000'
    })
    // Why: a reopened tab is a fresh surface — never the old PTY.
    expect(restored[0].id).not.toBe(tab.id)
    expect(restored[0].ptyId).toBeNull()
    expect(store.getState().recentlyClosedTerminalTabsByWorktree[WT]).toHaveLength(0)
  })

  it('returns false when the stack is empty (no double-restore)', () => {
    const store = makeSeededStore()
    const tab = store.getState().createTab(WT)
    store.getState().closeTab(tab.id)

    expect(store.getState().reopenClosedTerminalTab(WT)).toBe(true)
    expect(store.getState().reopenClosedTerminalTab(WT)).toBe(false)
    expect(store.getState().tabsByWorktree[WT]).toHaveLength(1)
  })

  it('skips local reopen on a remote-runtime worktree (host owns the terminal)', () => {
    // Why: a `runtime:` host id makes the worktree host-owned; a local createTab
    // would leave an unbacked phantom tab, so reopen must bail and let the
    // cross-type dispatcher fall through to browser/editor.
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1', hostId: 'runtime:env-1' })
        ]
      },
      activeWorktreeId: WT
    })
    store.setState({
      recentlyClosedTerminalTabsByWorktree: { [WT]: [{ startupCwd: '/path/wt1/api' }] },
      recentlyClosedTabKindsByWorktree: { [WT]: ['terminal'] }
    })

    expect(store.getState().reopenClosedTerminalTab(WT)).toBe(false)
    // No local tab spawned, and the snapshot is left intact (not consumed).
    expect(store.getState().tabsByWorktree[WT] ?? []).toHaveLength(0)
    expect(store.getState().recentlyClosedTerminalTabsByWorktree[WT]).toHaveLength(1)
  })

  it('reopens a legacy local worktree while another runtime is merely focused', () => {
    const store = makeSeededStore()
    store.setState({
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'env-1' }
    })
    const tab = store.getState().createTab(WT)
    store.getState().closeTab(tab.id)

    expect(store.getState().reopenClosedTerminalTab(WT)).toBe(true)
    expect(store.getState().tabsByWorktree[WT]).toHaveLength(1)
  })

  it('reopens SSH terminals through the renderer-owned create path', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WT, repoId: 'repo1', path: '/remote/wt1', hostId: 'ssh:host-1' })
        ]
      },
      activeWorktreeId: WT
    })
    const tab = store
      .getState()
      .createTab(WT, undefined, undefined, { startupCwd: '/remote/wt1/packages/app' })
    store.getState().closeTab(tab.id)

    expect(store.getState().reopenClosedTerminalTab(WT)).toBe(true)
    expect(store.getState().tabsByWorktree[WT]?.[0]?.startupCwd).toBe('/remote/wt1/packages/app')
  })
})

describe('reopenClosedTab cross-type MRU', () => {
  it('reopens closed tabs of mixed kinds in most-recent-first order', () => {
    const store = makeSeededStore()

    // Close order: editor → terminal → browser.
    store.setState({ openFiles: [makeOpenFile({ id: '/repo/a.ts', worktreeId: WT })] })
    store.getState().closeFile('/repo/a.ts')
    const terminal = store
      .getState()
      .createTab(WT, undefined, undefined, { startupCwd: '/path/wt1/api' })
    store.getState().closeTab(terminal.id)
    const browser = store.getState().createBrowserTab(WT, 'https://example.com', { title: 'Ex' })
    store.getState().closeBrowserTab(browser.id)

    expect(store.getState().recentlyClosedTabKindsByWorktree[WT]).toEqual([
      'browser',
      'terminal',
      'editor'
    ])

    // First press: browser comes back.
    expect(store.getState().reopenClosedTab(WT)).toBe(true)
    expect(store.getState().browserTabsByWorktree[WT]?.[0]?.url).toBe('https://example.com')
    expect(store.getState().tabsByWorktree[WT] ?? []).toHaveLength(0)

    // Second press: terminal comes back.
    expect(store.getState().reopenClosedTab(WT)).toBe(true)
    expect(store.getState().tabsByWorktree[WT]?.[0]?.startupCwd).toBe('/path/wt1/api')
    expect(store.getState().openFiles).toHaveLength(0)

    // Third press: editor comes back.
    expect(store.getState().reopenClosedTab(WT)).toBe(true)
    expect(store.getState().openFiles[0]?.filePath).toBe('/repo/a.ts')

    // Nothing left.
    expect(store.getState().reopenClosedTab(WT)).toBe(false)
  })

  it('skips kind entries whose per-type snapshot has drained', () => {
    const store = makeSeededStore()
    store.setState({
      recentlyClosedTabKindsByWorktree: { [WT]: ['browser', 'terminal'] },
      recentlyClosedTerminalTabsByWorktree: { [WT]: [{ startupCwd: '/path/wt1' }] },
      recentlyClosedBrowserTabsByWorktree: { [WT]: [] }
    })

    expect(store.getState().reopenClosedTab(WT)).toBe(true)

    expect(store.getState().tabsByWorktree[WT]?.[0]?.startupCwd).toBe('/path/wt1')
    expect(store.getState().recentlyClosedTabKindsByWorktree[WT]).toEqual([])
  })

  it('returns false when no tab was ever closed', () => {
    const store = makeSeededStore()
    expect(store.getState().reopenClosedTab(WT)).toBe(false)
  })
})
