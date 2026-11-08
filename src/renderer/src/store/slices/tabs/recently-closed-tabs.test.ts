// Reopen terminal/browser/editor snapshots in true cross-type MRU order via Cmd/Ctrl+Shift+T.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = {
  worktrees: {
    remove: vi.fn().mockResolvedValue(undefined),
    updateMeta: vi.fn().mockResolvedValue({})
  },
  pty: { kill: vi.fn().mockResolvedValue(undefined) },
  runtimeEnvironments: { call: vi.fn().mockResolvedValue({ ok: true, result: {} }) }
}

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

import { createTestStore, seedStore } from '../../testing/app-store-test-fixture'
import { makeWorktree } from '../worktrees/worktree.test-fixture'
import { makeOpenFile } from '../editor/types/open-file.test-fixture'

import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'
import { drawTabsFromMain } from './tabs-drawn-from-main.test-fixture'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
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

describe('reopenClosedTab cross-type MRU', () => {
  it('reopens closed tabs of mixed kinds in most-recent-first order', async () => {
    const store = makeSeededStore()
    // A layout-owner build draws the browser tab from main's frames.
    const main = await drawTabsFromMain(store)

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

    expect(store.getState().reopenClosedTab(WT)).toBe(true)
    await main.settle()
    expect(store.getState().browserTabsByWorktree[WT]?.[0]?.url).toBe('https://example.com')
    expect(store.getState().tabsByWorktree[WT] ?? []).toHaveLength(0)

    expect(store.getState().reopenClosedTab(WT)).toBe(true)
    expect(store.getState().tabsByWorktree[WT]?.[0]?.startupCwd).toBe('/path/wt1/api')
    expect(store.getState().openFiles).toHaveLength(0)

    expect(store.getState().reopenClosedTab(WT)).toBe(true)
    expect(store.getState().openFiles[0]?.filePath).toBe('/repo/a.ts')

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
})
