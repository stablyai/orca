import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeWorktree, seedStore } from '@/store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { LayoutApplyParams } from '../../../shared/rpc-contract/workspace-layout-params'
import { bindAutomationTerminal } from './automation-terminal-ownership'

const mocks = vi.hoisted(() => {
  const storeRef: { current: unknown } = { current: null }
  return {
    storeRef,
    callRuntimeRpc: vi.fn(async (_target: unknown, _method: string, _params: unknown) => ({
      ok: true,
      result: {}
    }))
  }
})

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/store', () => ({
  get useAppStore() {
    return mocks.storeRef.current
  }
}))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'
const LEAF = '11111111-1111-4111-8111-111111111111'

let store: ReturnType<typeof createTestStore>

beforeEach(() => {
  mocks.callRuntimeRpc.mockClear()
  store = createTestStore()
  mocks.storeRef.current = store
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  })
})

describe('a background agent tab in a layout-owner build', () => {
  it('binds the one-pane tree main made the tab with, so the bind changes no pane tree', () => {
    // As adoptAgentBackgroundSessionTab: the tab is made under its terminal's pane id.
    const tab = store.getState().createTab(WT, undefined, undefined, {
      id: 'tab-run',
      initialLeafId: LEAF,
      initialPtyId: 'pty-run',
      activate: false,
      recordInteraction: false
    })
    const [create] = mocks.callRuntimeRpc.mock.calls.map(
      ([, , params]) => LayoutApplyParams.parse(params).command
    )

    bindAutomationTerminal(tab, makePaneKey(tab.id, LEAF), 'pty-run', 'environment')

    expect(create).toEqual(expect.objectContaining({ type: 'createTerminalTab', leafId: LEAF }))
    expect(store.getState().terminalLayoutsByTabId[tab.id]?.root).toEqual({
      type: 'leaf',
      leafId: LEAF
    })
    // The bind sends nothing more: main already holds this tree.
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
  })
})
