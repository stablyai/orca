import { describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import '../../../../shared/workspace-session/workspace-doc-history'

createStoreCascadesMockApi()
const WT = 'repo1::/path/wt1'

describe('workspace document history title refresh', () => {
  it('does not publish unchanged titles but preserves real visits and title changes', () => {
    const store = createTestStore()
    const location = {
      kind: 'workspace-doc' as const,
      worktreeId: WT,
      filePath: '/path/wt1/doc.html'
    }
    store.getState().recordWorkspaceDocVisit(location, 'Document')
    const history = store.getState().workspaceDocHistory
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    for (let i = 0; i < 200; i++) {
      store.getState().recordWorkspaceDocVisit(location, 'Document', { bump: false })
    }
    expect(listener).not.toHaveBeenCalled()
    expect(store.getState().workspaceDocHistory).toBe(history)
    store.getState().recordWorkspaceDocVisit(location, 'Renamed', { bump: false })
    expect(store.getState().workspaceDocHistory[0]).toEqual({ ...history[0], title: 'Renamed' })
    store.getState().recordWorkspaceDocVisit(location, 'Renamed')
    expect(store.getState().workspaceDocHistory[0].visitCount).toBe(2)
    unsubscribe()
  })
})
