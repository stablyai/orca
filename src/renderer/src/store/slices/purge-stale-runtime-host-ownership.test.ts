import { describe, expect, it, vi } from 'vitest'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: {} }

import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'

const RUNTIME_A = toRuntimeExecutionHostId('env-a')
const RUNTIME_B = toRuntimeExecutionHostId('env-b')

describe('purgeStaleRuntimeHostState ownership evidence', () => {
  it('purges nested SSH rows when their transport-owning runtime is removed', () => {
    const store = createTestStore()
    const worktreeId = 'repoA::/nested-ssh'
    seedStore(store, {
      repos: [
        {
          id: 'repoA',
          path: '/nested-ssh',
          displayName: 'Nested SSH',
          executionHostId: RUNTIME_A
        } as never
      ],
      worktreesByRepo: {
        repoA: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repoA',
            hostId: 'ssh:hub-private-target',
            runtimeOwnerEnvironmentId: 'env-a'
          })
        ]
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'nested-tab', worktreeId })]
      }
    })

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    expect(store.getState().worktreesByRepo.repoA).toEqual([])
    expect(store.getState().tabsByWorktree[worktreeId]).toBeUndefined()
  })

  it('uses an explicit removed-host worktree as owner evidence before catalogs load', () => {
    const store = createTestStore()
    const removedWorktreeId = 'repoA::/hosted'
    const legacyWorktreeId = 'repoA::/legacy'
    seedStore(store, {
      repos: [],
      worktreesByRepo: {
        repoA: [
          makeWorktree({ id: removedWorktreeId, repoId: 'repoA', hostId: RUNTIME_A }),
          makeWorktree({ id: legacyWorktreeId, repoId: 'repoA', hostId: undefined })
        ]
      },
      tabsByWorktree: {
        [legacyWorktreeId]: [makeTab({ id: 'legacy-tab', worktreeId: legacyWorktreeId })]
      }
    })

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    expect(store.getState().worktreesByRepo.repoA).toEqual([])
    expect(store.getState().tabsByWorktree[legacyWorktreeId]).toBeUndefined()
  })

  it('purges restored session state owned by the removed host despite an exact-id survivor', () => {
    const store = createTestStore()
    const worktreeId = 'shared::/same/path'
    seedStore(store, {
      repos: [
        {
          id: 'shared',
          path: '/shared-a',
          displayName: 'A',
          executionHostId: RUNTIME_A
        } as never,
        {
          id: 'shared',
          path: '/shared-b',
          displayName: 'B',
          executionHostId: RUNTIME_B
        } as never
      ],
      worktreesByRepo: {
        shared: [
          makeWorktree({ id: worktreeId, repoId: 'shared', hostId: RUNTIME_A }),
          makeWorktree({ id: worktreeId, repoId: 'shared', hostId: RUNTIME_B })
        ]
      },
      tabsByWorktree: {
        [worktreeId]: [
          makeTab({ id: 'removed-host-tab', worktreeId, ptyId: 'remote:env-a@@terminal-a' })
        ]
      },
      restoredRuntimeHostIdByWorkspaceSessionKey: { [worktreeId]: RUNTIME_A },
      activeWorktreeId: worktreeId,
      activeWorkspaceKey: worktreeWorkspaceKey(worktreeId)
    })

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    const state = store.getState()
    expect(state.worktreesByRepo.shared).toHaveLength(1)
    expect(state.worktreesByRepo.shared[0]?.hostId).toBe(RUNTIME_B)
    expect(state.tabsByWorktree[worktreeId]).toBeUndefined()
    expect(state.restoredRuntimeHostIdByWorkspaceSessionKey[worktreeId]).toBeUndefined()
    expect(state.activeWorktreeId).toBeNull()
    expect(state.activeWorkspaceKey).toBeNull()
  })

  it('purges a removed host session after its catalog rows have already disappeared', () => {
    const store = createTestStore()
    const worktreeId = 'repoA::/session-only'
    seedStore(store, {
      repos: [],
      worktreesByRepo: {},
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'removed-host-tab', worktreeId })]
      },
      restoredRuntimeHostIdByWorkspaceSessionKey: { [worktreeId]: RUNTIME_A }
    })

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    const state = store.getState()
    expect(state.tabsByWorktree[worktreeId]).toBeUndefined()
    expect(state.restoredRuntimeHostIdByWorkspaceSessionKey[worktreeId]).toBeUndefined()
  })

  it('preserves a surviving restored session before its catalog rows load', () => {
    const store = createTestStore()
    const removedWorktreeId = 'shared::/removed-host'
    const survivingWorktreeId = 'shared::/surviving-host'
    const survivingTabs = [
      makeTab({
        id: 'surviving-host-tab',
        worktreeId: survivingWorktreeId,
        ptyId: 'remote:env-b@@terminal-b'
      })
    ]
    seedStore(store, {
      repos: [],
      worktreesByRepo: {},
      tabsByWorktree: {
        [removedWorktreeId]: [makeTab({ id: 'removed-host-tab', worktreeId: removedWorktreeId })],
        [survivingWorktreeId]: survivingTabs
      },
      restoredRuntimeHostIdByWorkspaceSessionKey: {
        [removedWorktreeId]: RUNTIME_A,
        [survivingWorktreeId]: RUNTIME_B
      },
      activeWorktreeId: survivingWorktreeId,
      activeWorkspaceKey: worktreeWorkspaceKey(survivingWorktreeId)
    })

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    const state = store.getState()
    expect(state.tabsByWorktree[removedWorktreeId]).toBeUndefined()
    expect(state.tabsByWorktree[survivingWorktreeId]).toBe(survivingTabs)
    expect(state.restoredRuntimeHostIdByWorkspaceSessionKey).toEqual({
      [survivingWorktreeId]: RUNTIME_B
    })
    expect(state.activeWorktreeId).toBe(survivingWorktreeId)
    expect(state.activeWorkspaceKey).toBe(worktreeWorkspaceKey(survivingWorktreeId))
  })
})
