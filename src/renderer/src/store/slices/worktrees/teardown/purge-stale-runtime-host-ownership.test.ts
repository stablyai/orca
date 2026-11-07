import { describe, expect, it, vi } from 'vitest'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: {} }

import { createTestStore, seedStore } from '../../../testing/app-store-test-fixture'
import { makeTab } from '../../../terminals/terminal-tab.test-fixture'
import { makeWorktree } from '../worktree.test-fixture'

const RUNTIME_A = toRuntimeExecutionHostId('env-a')
const RUNTIME_B = toRuntimeExecutionHostId('env-b')

describe('purgeStaleRuntimeHostState ownership evidence', () => {
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
})
