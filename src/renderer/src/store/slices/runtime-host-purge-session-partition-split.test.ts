/**
 * Directly covers the "stops new stale-partition writes" claim of #8881: once the
 * purge removes a removed-env runtime worktree row + repo, `buildHostIdByWorktreeId`
 * must resolve that worktree to 'local' (its owner is gone) and
 * `patchWorkspaceSessionByHost` must no longer route a write to the removed runtime
 * partition.
 */
import { describe, it, expect, vi } from 'vitest'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSessionPatch } from '../../../../shared/types'
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

    // Before: the row is owned by the runtime host.
    expect(buildHostIdByWorktreeId(store.getState() as HostPersistenceState)(WT_A)).toBe(RUNTIME_A)

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    // After: its owner is gone, so it falls back to the local partition.
    expect(buildHostIdByWorktreeId(store.getState() as HostPersistenceState)(WT_A)).toBe('local')
  })

  it('patchWorkspaceSessionByHost no longer writes the runtime partition after purge', async () => {
    const store = createTestStore()
    seedRuntimeRow(store)
    const api = {
      get: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue(undefined),
      setSync: vi.fn()
    }
    const patch = { activeWorktreeIdsOnShutdown: [WT_A] } as unknown as WorkspaceSessionPatch

    await patchWorkspaceSessionByHost(api, patch, store.getState() as HostPersistenceState)
    const runtimeWritesBefore = api.patch.mock.calls.filter(([, hostId]) => hostId === RUNTIME_A)
    expect(runtimeWritesBefore).toHaveLength(1)

    store.getState().purgeStaleRuntimeHostState(['env-a'])
    api.patch.mockClear()

    await patchWorkspaceSessionByHost(api, patch, store.getState() as HostPersistenceState)
    const runtimeWritesAfter = api.patch.mock.calls.filter(([, hostId]) => hostId === RUNTIME_A)
    expect(runtimeWritesAfter).toHaveLength(0)
    // The local write still happens.
    expect(api.patch).toHaveBeenCalled()
  })
})
