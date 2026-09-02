import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { shouldAutoCreateInitialTerminal } from '@/components/terminal/initial-terminal'

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

// Why: this is the half of PR #15513's contract that activation must NOT undo — hydration restores
// an emptied workspace as active, and the passive auto-create effect has to leave it alone. The
// end-to-end pin is tests/e2e/terminal-tab-close-restart-persistence.spec.ts, which only runs when
// an e2e spec changes, so assert the same decision here against a really-hydrated session.
describe('hydrated active workspace with a terminal tombstone', () => {
  it('reports no auto-create for the restored active worktree', () => {
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

    const state = store.getState()
    expect(state.activeWorktreeId).toBe(worktreeId)
    expect(state.tabsByWorktree[worktreeId]).toEqual([])
    const { renderableTabCount } = state.reconcileWorktreeTabModel(worktreeId)
    // The exact inputs Terminal.tsx's auto-create effect feeds shouldAutoCreateInitialTerminal.
    expect(renderableTabCount).toBe(0)
    expect(Object.hasOwn(state.tabsByWorktree, worktreeId)).toBe(true)
    expect(shouldAutoCreateInitialTerminal(renderableTabCount, true)).toBe(false)
  })
})
