import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import { createTestStore, seedStore } from '../../../testing/app-store-test-fixture'

import { makeWorktree } from '../../worktrees/worktree.test-fixture'
import { createStoreCascadesMockApi } from '../../../testing/app-store-cascade-api.test-fixture'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '../../tabs/tabs-drawn-from-main.test-fixture'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

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

const mockApi = createStoreCascadesMockApi()

let main: TabsDrawnFromMain | undefined
afterEach(() => {
  main?.close()
  main = undefined
})

/** Every change is drawn once this resolves; at once with the switch off. */
async function settled(): Promise<void> {
  await main?.settle()
}

describe('setActiveWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  it('uses unified MRU selection when closing an active browser tab', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt
    })
    main = await drawTabsFromMain(store)

    const previous = store.getState().createBrowserTab(wt, 'https://previous.example.com')
    await settled()
    store.getState().createBrowserTab(wt, 'https://neighbor.example.com')
    await settled()
    const closing = store.getState().createBrowserTab(wt, 'https://closing.example.com')
    await settled()
    store.getState().setActiveBrowserTab(previous.id)
    await settled()
    store.getState().setActiveBrowserTab(closing.id)
    await settled()

    store.getState().closeBrowserTab(closing.id)
    await settled()

    expect(store.getState().activeBrowserTabId).toBe(previous.id)
    expect(store.getState().activeBrowserTabIdByWorktree[wt]).toBe(previous.id)
  })

  it('keeps the unified MRU target when closing the last browser tab', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      activeWorktreeId: wt
    })
    main = await drawTabsFromMain(store)

    store.getState().createTab(wt)
    await settled()
    const previous = store.getState().createTab(wt)
    await settled()
    const closing = store.getState().createBrowserTab(wt, 'https://closing.example.com')
    await settled()

    store.getState().closeBrowserTab(closing.id)
    await settled()

    expect(store.getState().activeTabId).toBe(previous.id)
    expect(store.getState().activeTabType).toBe('terminal')
  })
})
