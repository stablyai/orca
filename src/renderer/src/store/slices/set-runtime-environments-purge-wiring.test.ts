/**
 * Wiring coverage for #8881: `setRuntimeEnvironments` must fire the stale-runtime
 * purge on the removal diff. Load-bearing because the call is optional-chained
 * (`get().purgeStaleRuntimeHostState?.(removedIds)`) — a rename/omission would
 * silently no-op while every pure-helper unit test still passed.
 */
import { describe, it, expect, vi } from 'vitest'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectHostSetup } from '../../../../shared/types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: {} }

import { createTestStore, seedStore, makeWorktree, makeTab, TEST_REPO } from './store-test-helpers'

const RUNTIME_A = toRuntimeExecutionHostId('env-a')

function env(id: string): PublicKnownRuntimeEnvironment {
  return { id } as unknown as PublicKnownRuntimeEnvironment
}

function seedStale(store: ReturnType<typeof createTestStore>): void {
  const WT_A = 'repoA::/wt-a'
  seedStore(store, {
    // In-memory previous saved list — the diff is computed against this.
    runtimeEnvironments: [env('env-a'), env('env-b')],
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
    projectHostSetups: [
      {
        id: 's-a',
        projectId: 'p',
        hostId: RUNTIME_A,
        repoId: 'repoA',
        path: '/repoA',
        displayName: 'A',
        setupState: 'ready',
        setupMethod: 'imported-existing-folder',
        createdAt: 0,
        updatedAt: 0
      } as ProjectHostSetup
    ],
    worktreesByRepo: {
      repoA: [makeWorktree({ id: WT_A, repoId: 'repoA', path: '/wt-a', hostId: RUNTIME_A })]
    },
    tabsByWorktree: { [WT_A]: [makeTab({ id: 'tab-a', worktreeId: WT_A })] }
  })
}

describe('setRuntimeEnvironments removal diff fires the stale-runtime purge', () => {
  it('purges the removed env owned repo/rows/setup/tab', () => {
    const store = createTestStore()
    seedStale(store)

    // env-a removed; env-b remains.
    store.getState().setRuntimeEnvironments([env('env-b')])

    const s = store.getState()
    expect(s.repos.map((r) => r.id)).toEqual(['repo1'])
    expect(s.projectHostSetups).toEqual([])
    expect(s.worktreesByRepo.repoA).toEqual([])
    expect(s.tabsByWorktree['repoA::/wt-a']).toBeUndefined()
    // The saved list itself was updated.
    expect(s.runtimeEnvironments.map((e) => e.id)).toEqual(['env-b'])
  })

  it('is a no-op for repos/rows when no environment was removed', () => {
    const store = createTestStore()
    seedStale(store)
    const reposRef = store.getState().repos
    const worktreesRef = store.getState().worktreesByRepo

    // Same set (order irrelevant) => empty removal diff => purge never runs.
    store.getState().setRuntimeEnvironments([env('env-a'), env('env-b')])

    const s = store.getState()
    expect(s.repos).toBe(reposRef)
    expect(s.worktreesByRepo).toBe(worktreesRef)
    expect(s.repos.map((r) => r.id)).toEqual(['repo1', 'repoA'])
  })
})
