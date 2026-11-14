// Reopen terminal/browser/editor snapshots in true cross-type MRU order via Cmd/Ctrl+Shift+T.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
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

import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'

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

describe('restoreRecentlyClosedTabPosition', () => {
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
