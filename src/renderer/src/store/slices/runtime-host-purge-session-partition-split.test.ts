/** After removed-runtime purge, host lookup falls back to local and session writes must stop targeting the retired partition (#8881). */
import { describe, it, expect, vi } from 'vitest'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSessionPatch } from '../../../../shared/workspace-session-state-types'
import {
  buildHostIdByWorktreeId,
  patchWorkspaceSessionByHost,
  type HostPersistenceState
} from '@/lib/workspace-session-host-persistence'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: {} }

import { createTestStore, seedStore, makeWorktree, TEST_REPO } from './store-test-helpers'

const RUNTIME_A = toRuntimeExecutionHostId('env-a')
const WT_A = 'repoA::/wt-a'

function seedRuntimeRow(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    repos: [
      TEST_REPO,
      {
        id: 'repoA',
        path: '/repoA',
        displayName: 'A',
        badgeColor: '#000',
        addedAt: 0,
        executionHostId: RUNTIME_A
      }
    ],
    worktreesByRepo: {
      repoA: [makeWorktree({ id: WT_A, repoId: 'repoA', path: '/wt-a', hostId: RUNTIME_A })]
    }
  })
}

describe('purge stops routing session writes to the removed runtime partition', () => {
  it('buildHostIdByWorktreeId resolves the removed worktree to local after purge', () => {
    const store = createTestStore()
    seedRuntimeRow(store)

    expect(buildHostIdByWorktreeId(store.getState() as HostPersistenceState)(WT_A)).toBe(RUNTIME_A)

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    expect(buildHostIdByWorktreeId(store.getState() as HostPersistenceState)(WT_A)).toBe('local')
  })

  it('patchWorkspaceSessionByHost no longer writes the runtime partition after purge', async () => {
    const store = createTestStore()
    seedRuntimeRow(store)
    const api = {
      get: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue(undefined)
    }
    const patch = { activeWorktreeIdsOnShutdown: [WT_A] } as unknown as WorkspaceSessionPatch

    await patchWorkspaceSessionByHost(api, patch, store.getState()).written
    const runtimeWritesBefore = api.patch.mock.calls.filter(([, hostId]) => hostId === RUNTIME_A)
    expect(runtimeWritesBefore).toHaveLength(1)

    store.getState().purgeStaleRuntimeHostState(['env-a'])
    api.patch.mockClear()

    await patchWorkspaceSessionByHost(api, patch, store.getState()).written
    const runtimeWritesAfter = api.patch.mock.calls.filter(([, hostId]) => hostId === RUNTIME_A)
    expect(runtimeWritesAfter).toHaveLength(0)
    expect(api.patch).toHaveBeenCalled()
  })
})
