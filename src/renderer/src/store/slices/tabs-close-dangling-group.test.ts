import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore } from './store-test-helpers'
import { drawTabsFromMain, type TabsDrawnFromMain } from './tabs-drawn-from-main.test-fixture'

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
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

createTabsSliceMockApi()

const WT = 'repo1::/tmp/feature'
const NO_MAIN: TabsDrawnFromMain = { settle: async () => {}, close: () => {} }

describe('closeUnifiedTab with a missing group record (#11308)', () => {
  let store: ReturnType<typeof createTestStore>
  let main: TabsDrawnFromMain

  beforeEach(() => {
    store = createTestStore()
  })

  afterEach(() => main.close())

  it.each(['terminal', 'editor'] as const)('still removes a %s tab', async (contentType) => {
    const kept = store.getState().createUnifiedTab(WT, contentType, { id: `${contentType}-kept` })
    const closing = store.getState().createUnifiedTab(WT, contentType, { id: `${contentType}-x` })
    // Only an editor tab's close goes to main first; a terminal's (rowless here) closes as today.
    main = contentType === 'editor' ? await drawTabsFromMain(store) : NO_MAIN
    store.setState({ groupsByWorktree: { [WT]: [] } })

    const result = store.getState().closeUnifiedTab(closing.id)
    // A layout-owner build closes an editor tab in main; its frame drops it.
    await main.settle()

    expect(result).toEqual({ closedTabId: closing.id, wasLastTab: false, worktreeId: WT })
    expect(store.getState().unifiedTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([kept.id])
  })

  it('reports the last tab when the worktree has no other tab', async () => {
    const only = store.getState().createUnifiedTab(WT, 'editor', { id: 'editor-only' })
    main = await drawTabsFromMain(store)
    store.setState({ groupsByWorktree: { [WT]: [] } })

    expect(store.getState().closeUnifiedTab(only.id)?.wasLastTab).toBe(true)
    await main.settle()
    expect(store.getState().unifiedTabsByWorktree[WT] ?? []).toEqual([])
  })
})
