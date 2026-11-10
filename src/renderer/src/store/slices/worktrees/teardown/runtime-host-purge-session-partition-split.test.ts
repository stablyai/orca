/** After removed-runtime purge, host lookup falls back to local and session writes must stop targeting the retired partition (#8881). */
import { describe, it, expect, vi } from 'vitest'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorkspaceSessionPatch } from '../../../../../../shared/workspace-session/workspace-session-state-types'
import { patchWorkspaceSessionByHost } from '@/lib/workspace/persistence/workspace-session-host-persistence'

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
import { makeWorktree } from '../worktree.test-fixture'
import { TEST_REPO } from '../../../repos/repo.test-fixture'

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
  it('patchWorkspaceSessionByHost no longer writes the runtime partition after purge', async () => {
    const store = createTestStore()
    seedRuntimeRow(store)
    const api = {
      get: vi.fn().mockResolvedValue({}),
      patch: vi.fn().mockResolvedValue(undefined)
    }
    const patch = { activeWorktreeIdsOnShutdown: [WT_A] } as unknown as WorkspaceSessionPatch

    await patchWorkspaceSessionByHost(api, patch, store.getState()).written
    expect(api.patch).toHaveBeenCalledWith(
      expect.objectContaining({ activeWorktreeIdsOnShutdown: ['repoA::/wt-a'] }),
      'runtime:env-a'
    )

    store.getState().purgeStaleRuntimeHostState(['env-a'])
    api.patch.mockClear()

    await patchWorkspaceSessionByHost(api, patch, store.getState()).written
    expect(api.patch).not.toHaveBeenCalledWith(expect.anything(), 'runtime:env-a')
    expect(api.patch).toHaveBeenCalledWith({ activeWorktreeIdsOnShutdown: ['repoA::/wt-a'] })
  })
})
