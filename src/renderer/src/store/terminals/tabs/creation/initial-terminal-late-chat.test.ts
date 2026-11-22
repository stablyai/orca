import { expect, it, vi } from 'vitest'
import { createTestStore } from '../../../testing/app-store-test-fixture'
import { createTabsSliceMockApi } from '../../../slices/tabs/tabs-slice-test-harness'
import type { LayoutApplyReply } from '../../../../../../shared/workspace-layout/workspace-layout-command-types'

const transport = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => transport)

const testStore = vi.hoisted(() => {
  const ref: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return ref
})
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => testStore.current!.getState() }
}))

createTabsSliceMockApi()

const { createInitialTerminalThroughLayoutOwner } =
  await import('./terminal-tab-create-through-layout-owner')

it('keeps a chat opened while initial terminal creation was awaiting the host', async () => {
  const store = createTestStore()
  testStore.current = store
  const workspace = 'repo1::/tmp/agent-worktree'
  store.setState({ activeWorktreeId: workspace })
  const reply = Promise.withResolvers<LayoutApplyReply>()
  transport.callRuntimeRpc.mockReturnValueOnce(reply.promise)

  expect(
    createInitialTerminalThroughLayoutOwner(store.getState, workspace, () => {
      store.getState().createTab(workspace)
    })
  ).toBe(true)

  store.getState().createUnifiedTab(workspace, 'agent-session', {
    id: 'codex-chat',
    entityId: 'codex-session',
    agentSessionAgent: 'codex'
  })
  reply.reject(new Error('Host write rolled back'))
  await reply.promise.catch(() => {})

  expect(store.getState().tabsByWorktree[workspace] ?? []).toEqual([])
  expect(
    store.getState().unifiedTabsByWorktree[workspace]?.map((tab) => ({
      id: tab.id,
      contentType: tab.contentType
    }))
  ).toEqual([{ id: 'codex-chat', contentType: 'agent-session' }])
})
