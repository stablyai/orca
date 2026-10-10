import { describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import {
  MAX_WORKSPACE_DOC_HISTORY_ENTRIES,
  workspaceDocHistoryEntriesEqual,
  type WorkspaceDocHistoryEntry
} from '../../../../shared/workspace-doc-history'

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

  it('still trims an over-cap history that a persisted state carried in', () => {
    const store = createTestStore()
    const location = {
      kind: 'workspace-doc' as const,
      worktreeId: WT,
      filePath: '/path/wt1/doc-0.html'
    }
    const overCap: WorkspaceDocHistoryEntry[] = Array.from(
      { length: MAX_WORKSPACE_DOC_HISTORY_ENTRIES + 5 },
      (_unused, index) => ({
        docLocation: {
          kind: 'workspace-doc' as const,
          worktreeId: WT,
          filePath: `/path/wt1/doc-${index}.html`
        },
        title: `Doc ${index}`,
        lastVisitedAt: 1_000 - index,
        visitCount: 1
      })
    )
    store.setState({ workspaceDocHistory: overCap })

    // The title is already current, but skipping here would strand the list above its cap forever.
    store.getState().recordWorkspaceDocVisit(location, 'Doc 0', { bump: false })

    expect(store.getState().workspaceDocHistory).toHaveLength(MAX_WORKSPACE_DOC_HISTORY_ENTRIES)
    expect(store.getState().workspaceDocHistory[0].title).toBe('Doc 0')
  })

  it('compares every entry field, so an added field cannot be silently dropped', () => {
    const base: WorkspaceDocHistoryEntry = {
      docLocation: { kind: 'workspace-doc', worktreeId: WT, filePath: '/path/wt1/doc.html' },
      title: 'Document',
      lastVisitedAt: 10,
      visitCount: 1
    }
    expect(workspaceDocHistoryEntriesEqual(base, { ...base })).toBe(true)
    expect(workspaceDocHistoryEntriesEqual(base, { ...base, title: 'Other' })).toBe(false)
    expect(workspaceDocHistoryEntriesEqual(base, { ...base, visitCount: 2 })).toBe(false)
    expect(workspaceDocHistoryEntriesEqual(base, { ...base, lastVisitedAt: 11 })).toBe(false)
    expect(
      workspaceDocHistoryEntriesEqual(base, { ...base, docLocation: { ...base.docLocation } })
    ).toBe(false)
    expect(
      workspaceDocHistoryEntriesEqual(base, {
        ...base,
        ...({ faviconUrl: 'x' } as Partial<WorkspaceDocHistoryEntry>)
      })
    ).toBe(false)
  })
})
