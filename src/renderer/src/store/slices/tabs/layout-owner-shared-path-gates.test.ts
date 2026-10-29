import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTabsSliceMockApi } from '../tabs-slice-test-harness'
import { createTestStore, makeTab } from '../store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('../../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

createTabsSliceMockApi()

const WT = 'repo1::/tmp/feature'

// Main draws the tab bar from its frames; these shared paths must not write structure of their own.
describe('shared tab paths in a layout-owner build', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
  })

  it('reconcile counts what would render and leaves the tab bar to main', () => {
    const entry = {
      id: 'stale-terminal',
      entityId: 'stale-terminal',
      groupId: 'g-1',
      worktreeId: WT,
      contentType: 'terminal' as const,
      label: 'Terminal 1',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    store.setState({
      unifiedTabsByWorktree: { [WT]: [entry] },
      groupsByWorktree: {
        [WT]: [{ id: 'g-1', worktreeId: WT, activeTabId: entry.id, tabOrder: [entry.id] }]
      },
      activeGroupIdByWorktree: { [WT]: 'g-1' },
      tabsByWorktree: { [WT]: [] }
    })
    const before = store.getState()

    expect(store.getState().reconcileWorktreeTabModel(WT)).toEqual({
      renderableTabCount: 0,
      activeRenderableTabId: null
    })
    store.getState().reconcileWorktreeTabModels([WT])

    expect(store.getState().unifiedTabsByWorktree).toBe(before.unifiedTabsByWorktree)
    expect(store.getState().groupsByWorktree).toBe(before.groupsByWorktree)
  })

  // A row's ptyId is the window's own field (the frame merge keeps it), so reconnect sets only that.
  it('reconnect advertises restored terminals and changes only each row ptyId', async () => {
    const rows = { [WT]: [makeTab({ id: 'tab-1', worktreeId: WT, ptyId: null })] }
    store.setState({
      tabsByWorktree: rows,
      terminalLayoutsByTabId: {},
      pendingReconnectWorktreeIds: [WT],
      pendingReconnectTabByWorktree: { [WT]: ['tab-1'] },
      pendingReconnectPtyIdByTabId: { 'tab-1': 'pty-1' }
    })

    await store.getState().reconnectPersistedTerminals()

    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual(['pty-1'])
    expect(store.getState().tabsByWorktree).toEqual({
      [WT]: [{ ...rows[WT][0], ptyId: 'pty-1' }]
    })
    expect(store.getState().workspaceSessionReady).toBe(true)
  })
})
