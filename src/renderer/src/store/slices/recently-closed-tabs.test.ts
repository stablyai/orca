/**
 * Cmd/Ctrl+Shift+T reopen behavior: terminal tabs join the recently-closed
 * stacks, and the unified dispatcher pops the most recently closed tab of any
 * kind (terminal/browser/editor) in true cross-type MRU order.
 */
import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest'
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

import {
  createTestStore,
  seedStore,
  makeWorktree,
  makeOpenFile,
  makeTabGroup,
  makeUnifiedTab
} from './store-test-helpers'
import {
  pushRecentlyClosedTabKind,
  remapClosedTerminalTabSnapshotCwds,
  restoreRecentlyClosedTabPosition
} from './recently-closed-tabs'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { drawTabsFromMain } from './tabs-drawn-from-main.test-fixture'
import { loadMainLayoutModel } from '@/runtime/main-loaded-layout-frames.test-fixture'
import { openWorkspaceLayoutFrameSync } from '@/runtime/workspace-layout-frame-sync'
import { endLayoutFramePositions } from '@/runtime/layout-frame-position'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

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

/** A layout-owner build's main, applying the window's commands, with its frames drawn into
 *  `store`; nothing to open otherwise. */
async function mainWithFrames(store: ReturnType<typeof createTestStore>): Promise<() => void> {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return () => {}
  }
  layoutApplyTestTransport.reset()
  layoutApplyTestTransport.useMainModel(
    loadMainLayoutModel('local', buildWorkspaceSessionPayload(store.getState()))
  )
  layoutApplyTestTransport.answerWith('apply')
  const sync = openWorkspaceLayoutFrameSync(store)
  sync.start()
  await layoutApplyTestTransport.settle()
  return () => {
    sync.close()
    endLayoutFramePositions()
  }
}

/** The user names and colors the tab; a layout-owner build's main frame draws both. */
async function titleAndColor(store: ReturnType<typeof createTestStore>, tabId: string) {
  store.getState().setTabCustomTitle(tabId, 'build shell')
  store.getState().setTabColor(tabId, '#ff0000')
  await framesDrawn()
}

/** Main's answers, and the frames they wait on, drawn. */
async function framesDrawn(): Promise<void> {
  await layoutApplyTestTransport.settle()
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

describe('terminal recently-closed capture', () => {
  it('captures a snapshot and kind entry on user close', async () => {
    const store = makeSeededStore()
    const closeMain = await mainWithFrames(store)
    onTestFinished(closeMain)
    const tab = store
      .getState()
      .createTab(WT, undefined, undefined, { startupCwd: '/path/wt1/packages/app' })
    await titleAndColor(store, tab.id)

    store.getState().closeTab(tab.id)
    await framesDrawn()

    expect(store.getState().recentlyClosedTerminalTabsByWorktree[WT]).toEqual([
      expect.objectContaining({
        startupCwd: '/path/wt1/packages/app',
        customTitle: 'build shell',
        color: '#ff0000',
        position: expect.objectContaining({ groupIndex: 0 })
      })
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

  it('skips capture for a confirmed parked PTY exit', async () => {
    const store = makeSeededStore()
    const tab = store.getState().createTab(WT)

    store.getState().closeTab(tab.id, { captureRecentlyClosed: false })
    await layoutApplyTestTransport.settle()

    expect(store.getState().recentlyClosedTerminalTabsByWorktree[WT]).toBeUndefined()
    expect(store.getState().recentlyClosedTabKindsByWorktree[WT]).toBeUndefined()
  })

  it('caps the terminal stack at 10 snapshots, newest first', async () => {
    const store = makeSeededStore()
    for (let i = 0; i < 12; i++) {
      const tab = store
        .getState()
        .createTab(WT, undefined, undefined, { startupCwd: `/path/wt1/dir-${i}` })
      store.getState().closeTab(tab.id)
      await layoutApplyTestTransport.settle()
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
  it('restores the tab bar and group position of a closed middle tab', async () => {
    const store = makeSeededStore()
    const first = store.getState().createTab(WT)
    const middle = store.getState().createTab(WT)
    const last = store.getState().createTab(WT)
    store.getState().setTabBarOrder(WT, [first.id, middle.id, last.id])

    store.getState().closeTab(middle.id)
    await layoutApplyTestTransport.settle()
    expect(store.getState().reopenClosedTerminalTab(WT)).toBe(true)
    await layoutApplyTestTransport.settle()

    const restored = store
      .getState()
      .tabsByWorktree[WT]?.find((tab) => tab.id !== first.id && tab.id !== last.id)
    expect(restored).toBeDefined()
    expect(store.getState().tabBarOrderByWorktree[WT]).toEqual([first.id, restored!.id, last.id])

    const group = store.getState().groupsByWorktree[WT]?.[0]
    expect(
      group?.tabOrder.map(
        (id) => store.getState().unifiedTabsByWorktree[WT]?.find((tab) => tab.id === id)?.entityId
      )
    ).toEqual([first.id, restored!.id, last.id])
  })

  it('recreates a fresh terminal with the snapshot cwd, shell, title, and color', async () => {
    const store = makeSeededStore()
    const closeMain = await mainWithFrames(store)
    onTestFinished(closeMain)
    const tab = store
      .getState()
      .createTab(WT, undefined, 'zsh', { startupCwd: '/path/wt1/packages/app' })
    await titleAndColor(store, tab.id)
    store.getState().closeTab(tab.id)
    await framesDrawn()
    expect(store.getState().tabsByWorktree[WT]).toHaveLength(0)

    expect(store.getState().reopenClosedTerminalTab(WT)).toBe(true)
    await framesDrawn()

    const restored = store.getState().tabsByWorktree[WT]
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({
      startupCwd: '/path/wt1/packages/app',
      shellOverride: 'zsh'
    })
    expect(restored[0]).toMatchObject({ customTitle: 'build shell', color: '#ff0000' })
    // Why: a reopened tab is a fresh surface — never the old PTY.
    expect(restored[0].id).not.toBe(tab.id)
    expect(restored[0].ptyId).toBeNull()
    expect(store.getState().recentlyClosedTerminalTabsByWorktree[WT]).toHaveLength(0)
  })

  it('returns false when the stack is empty (no double-restore)', async () => {
    const store = makeSeededStore()
    const tab = store.getState().createTab(WT)
    store.getState().closeTab(tab.id)
    await layoutApplyTestTransport.settle()

    expect(store.getState().reopenClosedTerminalTab(WT)).toBe(true)
    await layoutApplyTestTransport.settle()
    expect(store.getState().reopenClosedTerminalTab(WT)).toBe(false)
    await layoutApplyTestTransport.settle()
    expect(store.getState().tabsByWorktree[WT]).toHaveLength(1)
  })

  it('skips local reopen on a remote-runtime worktree (host owns the terminal)', async () => {
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
    await layoutApplyTestTransport.settle()
    // No local tab spawned, and the snapshot is left intact (not consumed).
    expect(store.getState().tabsByWorktree[WT] ?? []).toHaveLength(0)
    expect(store.getState().recentlyClosedTerminalTabsByWorktree[WT]).toHaveLength(1)
  })

  it('reopens a legacy local worktree while another runtime is merely focused', async () => {
    const store = makeSeededStore()
    store.setState({
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'env-1' }
    })
    const tab = store.getState().createTab(WT)
    store.getState().closeTab(tab.id)
    await layoutApplyTestTransport.settle()

    expect(store.getState().reopenClosedTerminalTab(WT)).toBe(true)
    await layoutApplyTestTransport.settle()
    expect(store.getState().tabsByWorktree[WT]).toHaveLength(1)
  })

  it('reopens SSH terminals through the renderer-owned create path', async () => {
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
    await layoutApplyTestTransport.settle()

    expect(store.getState().reopenClosedTerminalTab(WT)).toBe(true)
    await layoutApplyTestTransport.settle()
    expect(store.getState().tabsByWorktree[WT]?.[0]?.startupCwd).toBe('/remote/wt1/packages/app')
  })
})

describe('restoreRecentlyClosedTabPosition', () => {
  it('selects the unified tab in the captured group when an entity is shared', () => {
    const reordered = vi.fn()
    const otherTab = makeUnifiedTab({
      id: 'other-tab',
      entityId: 'shared-file',
      groupId: 'other-group',
      worktreeId: WT,
      contentType: 'editor'
    })
    const capturedTab = makeUnifiedTab({
      id: 'captured-tab',
      entityId: 'shared-file',
      groupId: 'captured-group',
      worktreeId: WT,
      contentType: 'editor'
    })
    const capturedSibling = makeUnifiedTab({
      id: 'captured-sibling',
      entityId: 'sibling-file',
      groupId: 'captured-group',
      worktreeId: WT,
      contentType: 'editor'
    })
    const state = {
      tabBarOrderByWorktree: { [WT]: ['shared-file'] },
      groupsByWorktree: {
        [WT]: [
          makeTabGroup({
            id: 'other-group',
            worktreeId: WT,
            activeTabId: 'other-tab',
            tabOrder: ['other-tab']
          }),
          makeTabGroup({
            id: 'captured-group',
            worktreeId: WT,
            activeTabId: 'captured-sibling',
            tabOrder: ['captured-sibling', 'captured-tab']
          })
        ]
      },
      unifiedTabsByWorktree: { [WT]: [otherTab, capturedTab, capturedSibling] }
    }

    restoreRecentlyClosedTabPosition(
      () => ({
        ...state,
        setTabBarOrder: vi.fn(),
        reorderUnifiedTabs: reordered
      }),
      WT,
      'shared-file',
      { groupId: 'captured-group', groupIndex: 0 }
    )

    // A switch-on build also marks the reorder as one main already made.
    expect(reordered).toHaveBeenCalledWith(
      'captured-group',
      ['captured-tab', 'captured-sibling'],
      ORCA_LAYOUT_OWNER_IS_MAIN
        ? { recordInteraction: false, layoutOwnerHandled: true }
        : { recordInteraction: false }
    )
  })

  it('does not reuse a stale flat index after group drag reordering', async () => {
    const store = makeSeededStore()
    const first = store.getState().createTab(WT)
    const middle = store.getState().createTab(WT)
    const last = store.getState().createTab(WT)
    const groupId = store.getState().groupsByWorktree[WT]?.[0]?.id
    if (!groupId) {
      throw new Error('Expected a root tab group')
    }
    store.getState().setTabBarOrder(WT, [first.id, middle.id, last.id])
    store.getState().reorderUnifiedTabs(groupId, [first.id, last.id, middle.id])

    store.getState().closeTab(middle.id)
    await layoutApplyTestTransport.settle()
    expect(store.getState().recentlyClosedTerminalTabsByWorktree[WT]?.[0]?.position).toEqual({
      groupId,
      groupIndex: 2
    })

    expect(store.getState().reopenClosedTerminalTab(WT)).toBe(true)
    await layoutApplyTestTransport.settle()
    const restored = store
      .getState()
      .tabsByWorktree[WT]?.find((tab) => tab.id !== first.id && tab.id !== last.id)
    expect(store.getState().tabBarOrderByWorktree[WT]).toEqual([first.id, last.id, restored?.id])
    expect(store.getState().groupsByWorktree[WT]?.[0]?.tabOrder).toEqual([
      first.id,
      last.id,
      restored?.id
    ])
  })
})

describe('reopenClosedTab cross-type MRU', () => {
  it('reopens closed tabs of mixed kinds in most-recent-first order', async () => {
    const store = makeSeededStore()
    // A layout-owner build draws the browser tab from main's frames.
    const main = await drawTabsFromMain(store)

    // Close order: editor → terminal → browser.
    store.setState({ openFiles: [makeOpenFile({ id: '/repo/a.ts', worktreeId: WT })] })
    store.getState().closeFile('/repo/a.ts')
    const terminal = store
      .getState()
      .createTab(WT, undefined, undefined, { startupCwd: '/path/wt1/api' })
    store.getState().closeTab(terminal.id)
    await layoutApplyTestTransport.settle()
    const browser = store.getState().createBrowserTab(WT, 'https://example.com', { title: 'Ex' })
    await main.settle()
    store.getState().closeBrowserTab(browser.id)
    await main.settle()

    expect(store.getState().recentlyClosedTabKindsByWorktree[WT]).toEqual([
      'browser',
      'terminal',
      'editor'
    ])

    // First press: browser comes back.
    expect(store.getState().reopenClosedTab(WT)).toBe(true)
    await main.settle()
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
    main.close()
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
