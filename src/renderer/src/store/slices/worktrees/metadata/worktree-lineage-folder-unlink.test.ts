import { describe, expect, it, vi } from 'vitest'
import { applyWorktreeLineageUpdate } from './worktree-lineage-refresh'
import { createTestStore, seedStore } from '../../../testing/app-store-test-fixture'
import { createStoreCascadesMockApi } from '../../../testing/app-store-cascade-api.test-fixture'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

createStoreCascadesMockApi()

describe('Remove from Parent on a folder workspace', () => {
  it("drops the folder's own link, keyed by its id, and leaves other links", () => {
    const store = createTestStore()
    const folderLink = {
      childWorkspaceKey: 'folder:notes' as const,
      childInstanceId: null,
      parentWorkspaceKey: 'folder:atlas-home' as const,
      parentInstanceId: null,
      origin: 'orchestration' as const,
      capture: { source: 'orchestration-context' as const, confidence: 'explicit' as const },
      createdAt: 1
    }
    const otherLink = { ...folderLink, childWorkspaceKey: 'folder:other' as const }
    seedStore(store, {
      workspaceLineageByChildKey: { 'folder:notes': folderLink, 'folder:other': otherLink }
    })

    applyWorktreeLineageUpdate(store.setState, 'folder:notes', {
      target: { kind: 'local' },
      hostId: 'local',
      lineage: null
    })

    expect(store.getState().workspaceLineageByChildKey).toEqual({ 'folder:other': otherLink })
  })
})
