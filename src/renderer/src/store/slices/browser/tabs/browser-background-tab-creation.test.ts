import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import { createTestStore, seedStore } from '../../../testing/app-store-test-fixture'
import { makeTab } from '../../../terminals/testing/terminal-tab.test-fixture'
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

  it('does not switch the global surface when creating a browser tab for a background worktree', async () => {
    const store = createTestStore()
    const activeWt = 'repo1::/path/wt1'
    const backgroundWt = 'repo1::/path/wt2'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: activeWt, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: backgroundWt, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      activeWorktreeId: activeWt,
      activeTabType: 'terminal',
      tabsByWorktree: {
        [activeWt]: [makeTab({ id: 'terminal-1', worktreeId: activeWt })],
        [backgroundWt]: [makeTab({ id: 'terminal-2', worktreeId: backgroundWt })]
      }
    })
    main = await drawTabsFromMain(store)

    store.getState().createBrowserTab(backgroundWt, 'https://example.com', { activate: true })
    await settled()

    const s = store.getState()
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeTabTypeByWorktree[backgroundWt]).toBe('browser')
  })
})
