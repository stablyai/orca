import { describe, expect, it, vi } from 'vitest'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { createTabsSliceMockApi } from '@/store/slices/tabs-slice-test-harness'
import { buildPersistedUnifiedTabSessionData } from '@/lib/workspace-session-unified-tabs'
import { buildMobileSessionTabSnapshots } from '@/runtime/sync-runtime-graph'
import {
  tabContentTypeSchema,
  workspaceVisibleTabTypeSchema
} from '../../../../shared/workspace-session-tab-type-schema'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
createTabsSliceMockApi()

describe('workspace canvas tabs', () => {
  it.each(['repo::feature', 'folder:design'])(
    'creates, reconciles, persists and closes a canvas in %s without a terminal',
    (worktreeId) => {
      const store = createTestStore()
      store.setState({
        activeWorktreeId: worktreeId,
        activeWorkspaceExecutionHostId: 'runtime:worker'
      })
      const tab = store.getState().createUnifiedTab(worktreeId, 'canvas', { label: 'Canvas' })
      expect(tab.executionHostId).toBe('runtime:worker')
      store.getState().focusGroup(worktreeId, tab.groupId)
      expect(store.getState().reconcileWorktreeTabModel(worktreeId).renderableTabCount).toBe(1)
      const persisted = buildPersistedUnifiedTabSessionData(store.getState())
      expect(persisted.unifiedTabs?.[worktreeId]).toEqual([tab])
      expect(tabContentTypeSchema.parse(tab.contentType)).toBe('canvas')
      expect(workspaceVisibleTabTypeSchema.parse(store.getState().activeTabType)).toBe('canvas')
      store.getState().closeUnifiedTab(tab.id)
      expect(store.getState().unifiedTabsByWorktree[worktreeId]).toEqual([])
      expect(store.getState().tabsByWorktree[worktreeId] ?? []).toEqual([])
    }
  )
  it('does not publish client-only canvas tabs or unknown active types to paired clients', () => {
    const store = createTestStore()
    const worktreeId = 'repo::feature'
    store.setState({ activeWorktreeId: worktreeId, activeWorkspaceExecutionHostId: 'local' })
    const tab = store.getState().createUnifiedTab(worktreeId, 'canvas', { label: 'Canvas' })
    const snapshots = buildMobileSessionTabSnapshots(store.getState())
    for (const snapshot of snapshots) {
      expect(snapshot.tabs.some((item) => item.id === tab.id)).toBe(false)
      expect(snapshot.activeTabType).not.toBe('canvas')
    }
  })
})
