import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('@/components/terminal-pane/pty-transport', () => ({
  registerEagerPtyBuffer: vi.fn(),
  ensurePtyDispatcher: vi.fn()
}))

// @ts-expect-error -- hydration does not call the mocked preload surface.
globalThis.window = { api: {} }

describe('explicit empty terminal hydration', () => {
  it('preserves a git worktree terminal tombstone', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/wt-1'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/wt-1' })]
      }
    })

    store.getState().hydrateWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'repo1',
      activeWorktreeId: worktreeId,
      tabsByWorktree: { [worktreeId]: [] }
    })

    expect(store.getState().tabsByWorktree).toEqual({ [worktreeId]: [] })
  })

  it('preserves a folder workspace terminal tombstone', () => {
    const store = createTestStore()
    const workspaceKey = folderWorkspaceKey('folder-1')

    store.getState().hydrateWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        activeWorkspaceKey: workspaceKey,
        activeWorktreeId: workspaceKey,
        tabsByWorktree: { [workspaceKey]: [] }
      },
      { additionalValidWorkspaceKeys: [workspaceKey] }
    )

    expect(store.getState().tabsByWorktree).toEqual({ [workspaceKey]: [] })
  })
})
