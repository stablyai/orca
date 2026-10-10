import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

createTabsSliceMockApi()

const WT = 'repo1::/tmp/feature'

describe('closeUnifiedTab with a missing group record (#11308)', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
  })

  it.each(['terminal', 'editor'] as const)('still removes a %s tab', (contentType) => {
    const kept = store.getState().createUnifiedTab(WT, contentType, { id: `${contentType}-kept` })
    const closing = store.getState().createUnifiedTab(WT, contentType, { id: `${contentType}-x` })
    store.setState({ groupsByWorktree: { [WT]: [] } })

    const result = store.getState().closeUnifiedTab(closing.id)

    expect(result).toEqual({ closedTabId: closing.id, wasLastTab: false, worktreeId: WT })
    expect(store.getState().unifiedTabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([kept.id])
  })

  it('reports the last tab when the worktree has no other tab', () => {
    const only = store.getState().createUnifiedTab(WT, 'editor', { id: 'editor-only' })
    store.setState({ groupsByWorktree: { [WT]: [] } })

    expect(store.getState().closeUnifiedTab(only.id)?.wasLastTab).toBe(true)
    expect(store.getState().unifiedTabsByWorktree[WT]).toEqual([])
  })
})
