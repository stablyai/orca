/**
 * Action coverage for `purgeStaleRuntimeHostState` (#8881).
 *
 * Removing a runtime identity must retire the repos/setups/rows/detected rows and
 * cascaded tab state it owned, while leaving local, ssh, and — the P1 regression —
 * a *never-saved* runtime-stamped LOCAL repo (a serving instance's own row)
 * untouched. The action is scoped to the removal diff, so it must no-op (no
 * sortEpoch bump) for an empty diff or an env that matches nothing.
 */
import { describe, it, expect, vi } from 'vitest'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import type { ProjectHostSetup, DetectedWorktreeListResult } from '../../../../shared/types'

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
const RUNTIME_NEVER_SAVED = toRuntimeExecutionHostId('env-serving-client')

function setup(overrides: Partial<ProjectHostSetup> & { id: string }): ProjectHostSetup {
  return {
    projectId: 'p',
    hostId: 'local',
    repoId: '',
    path: '/tmp',
    displayName: 'setup',
    setupState: 'ready',
    setupMethod: 'existing',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  } as ProjectHostSetup
}

function detectedResult(
  repoId: string,
  worktrees: DetectedWorktreeListResult['worktrees']
): DetectedWorktreeListResult {
  return { repoId, authoritative: true, source: 'git', worktrees }
}

function detected(
  id: string,
  repoId: string,
  hostId: ReturnType<typeof toRuntimeExecutionHostId> | 'local' | undefined
): DetectedWorktreeListResult['worktrees'][number] {
  return {
    ...makeWorktree({ id, repoId, hostId }),
    ownership: 'orca-managed',
    selectedCheckout: true,
    visible: true
  } as DetectedWorktreeListResult['worktrees'][number]
}

describe('purgeStaleRuntimeHostState', () => {
  it('purges the removed env and preserves local + never-saved runtime-stamped repos', () => {
    const store = createTestStore()
    const WT_A = 'repoA::/wt-a'
    const TAB_A = 'tab-a'
    seedStore(store, {
      // A local repo, a runtime:env-a repo (the removed one), and the P1 regression
      // case: a LOCAL repo carrying a runtime stamp whose env was never saved.
      repos: [
        TEST_REPO,
        {
          id: 'repoA',
          path: '/repoA',
          displayName: 'A',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: RUNTIME_A
        },
        {
          id: 'repoServing',
          path: '/repoServing',
          displayName: 'Serving',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: RUNTIME_NEVER_SAVED
        }
      ],
      projectHostSetups: [
        setup({ id: 's-local', repoId: 'repo1', hostId: 'local' }),
        setup({ id: 's-a', repoId: 'repoA', hostId: RUNTIME_A }),
        setup({ id: 's-a-repoless', repoId: '', hostId: RUNTIME_A }),
        setup({ id: 's-serving', repoId: 'repoServing', hostId: RUNTIME_NEVER_SAVED })
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: 'repo1::/wt-local', repoId: 'repo1', hostId: 'local' })],
        repoA: [makeWorktree({ id: WT_A, repoId: 'repoA', path: '/wt-a', hostId: RUNTIME_A })],
        repoServing: [
          makeWorktree({
            id: 'repoServing::/wt-s',
            repoId: 'repoServing',
            hostId: RUNTIME_NEVER_SAVED
          })
        ]
      },
      detectedWorktreesByRepo: {
        repoA: detectedResult('repoA', [detected(WT_A, 'repoA', RUNTIME_A)])
      },
      tabsByWorktree: { [WT_A]: [makeTab({ id: TAB_A, worktreeId: WT_A })] }
    })
    const epochBefore = store.getState().sortEpoch

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    const s = store.getState()
    // Removed env's repo/setups/rows/detected/tab all gone.
    expect(s.repos.map((r) => r.id)).toEqual(['repo1', 'repoServing'])
    expect(s.projectHostSetups.map((x) => x.id).sort()).toEqual(['s-local', 's-serving'])
    expect(s.worktreesByRepo.repoA).toEqual([])
    expect(s.detectedWorktreesByRepo.repoA.worktrees).toEqual([])
    expect(s.tabsByWorktree[WT_A]).toBeUndefined()
    // Local repo AND the never-saved runtime-stamped local repo BOTH survive.
    expect(s.worktreesByRepo.repo1).toHaveLength(1)
    expect(s.worktreesByRepo.repoServing).toHaveLength(1)
    // sortEpoch bumped because rows changed.
    expect(s.sortEpoch).toBe(epochBefore + 1)
  })

  it('keeps a still-saved sibling runtime env when another runtime env is removed', () => {
    const store = createTestStore()
    const RUNTIME_B = toRuntimeExecutionHostId('env-b')
    seedStore(store, {
      repos: [
        {
          id: 'repoA',
          path: '/repoA',
          displayName: 'A',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: RUNTIME_A
        },
        {
          id: 'repoB',
          path: '/repoB',
          displayName: 'B',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: RUNTIME_B
        }
      ],
      worktreesByRepo: {
        repoA: [makeWorktree({ id: 'repoA::/wt-a', repoId: 'repoA', hostId: RUNTIME_A })],
        repoB: [makeWorktree({ id: 'repoB::/wt-b', repoId: 'repoB', hostId: RUNTIME_B })]
      }
    })

    // Only env-a is removed; env-b is a still-saved sibling runtime host.
    store.getState().purgeStaleRuntimeHostState(['env-a'])

    const s = store.getState()
    expect(s.repos.map((r) => r.id)).toEqual(['repoB'])
    expect(s.worktreesByRepo.repoB).toHaveLength(1)
    expect(s.worktreesByRepo.repoA).toEqual([])
  })

  it('is a no-op (no sortEpoch bump) for an empty removed set and for a non-matching env', () => {
    const store = createTestStore()
    seedStore(store, {
      repos: [TEST_REPO],
      projectHostSetups: [setup({ id: 's-local', repoId: 'repo1', hostId: 'local' })],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: 'repo1::/wt', repoId: 'repo1', hostId: 'local' })]
      }
    })
    const before = store.getState()
    const epochBefore = before.sortEpoch
    const worktreesRef = before.worktreesByRepo
    const reposRef = before.repos
    const setupsRef = before.projectHostSetups

    store.getState().purgeStaleRuntimeHostState([])
    store.getState().purgeStaleRuntimeHostState(['env-does-not-exist'])

    const s = store.getState()
    expect(s.sortEpoch).toBe(epochBefore)
    // Nothing stale => the reducer returns state untouched (same references).
    expect(s.worktreesByRepo).toBe(worktreesRef)
    expect(s.repos).toBe(reposRef)
    expect(s.projectHostSetups).toBe(setupsRef)
  })

  it('same-repoId-on-two-hosts: keeps an ambiguous unhosted row and the repo key', () => {
    const store = createTestStore()
    // repoId 'shared' exists under both local and runtime:env-a in worktreesByRepo.
    seedStore(store, {
      repos: [
        { id: 'shared', path: '/shared', displayName: 'shared', badgeColor: '#000', addedAt: 0 },
        {
          id: 'shared',
          path: '/shared',
          displayName: 'shared',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: RUNTIME_A
        }
      ],
      worktreesByRepo: {
        shared: [
          makeWorktree({ id: 'shared::/wt-local', repoId: 'shared', hostId: undefined }),
          makeWorktree({ id: 'shared::/wt-a', repoId: 'shared', hostId: RUNTIME_A })
        ]
      }
    })

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    const s = store.getState()
    expect(s.worktreesByRepo).toHaveProperty('shared')
    expect(s.worktreesByRepo.shared.map((w) => w.id)).toEqual(['shared::/wt-local'])
    expect(s.worktreesByRepo.shared[0]?.hostId).toBeUndefined()
  })

  it('preserves worktree-scoped state when the exact same id survives on another host', () => {
    const store = createTestStore()
    const RUNTIME_B = toRuntimeExecutionHostId('env-b')
    const worktreeId = 'shared::/same/path'
    const tabs = [makeTab({ id: 'tab-surviving', worktreeId })]
    seedStore(store, {
      repos: [
        {
          id: 'shared',
          path: '/shared',
          displayName: 'shared',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: RUNTIME_A
        },
        {
          id: 'shared',
          path: '/shared',
          displayName: 'shared',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: RUNTIME_B
        }
      ],
      worktreesByRepo: {
        shared: [
          makeWorktree({ id: worktreeId, repoId: 'shared', hostId: RUNTIME_A }),
          makeWorktree({ id: worktreeId, repoId: 'shared', hostId: RUNTIME_B })
        ]
      },
      tabsByWorktree: { [worktreeId]: tabs },
      restoredRuntimeHostIdByWorkspaceSessionKey: { [worktreeId]: RUNTIME_B },
      activeWorktreeId: worktreeId,
      activeWorkspaceKey: worktreeWorkspaceKey(worktreeId)
    })
    const restoredOwners = store.getState().restoredRuntimeHostIdByWorkspaceSessionKey

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    const s = store.getState()
    expect(s.worktreesByRepo.shared).toHaveLength(1)
    expect(s.worktreesByRepo.shared[0]?.hostId).toBe(RUNTIME_B)
    expect(s.tabsByWorktree[worktreeId]).toBe(tabs)
    expect(s.restoredRuntimeHostIdByWorkspaceSessionKey).toBe(restoredOwners)
    expect(s.restoredRuntimeHostIdByWorkspaceSessionKey[worktreeId]).toBe(RUNTIME_B)
    expect(s.activeWorktreeId).toBe(worktreeId)
    expect(s.activeWorkspaceKey).toBe(worktreeWorkspaceKey(worktreeId))
  })

  it('purges a legacy unhosted row when its sole repo owner was removed', () => {
    const store = createTestStore()
    const worktreeId = 'repoA::/legacy'
    seedStore(store, {
      repos: [
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
        repoA: [makeWorktree({ id: worktreeId, repoId: 'repoA', hostId: undefined })]
      },
      tabsByWorktree: { [worktreeId]: [makeTab({ id: 'legacy-tab', worktreeId })] }
    })

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    const s = store.getState()
    expect(s.worktreesByRepo.repoA).toEqual([])
    expect(s.tabsByWorktree[worktreeId]).toBeUndefined()
  })

  it('uses a removed host setup to purge an unhosted row before its repo loads', () => {
    const store = createTestStore()
    const worktreeId = 'repoA::/legacy'
    seedStore(store, {
      repos: [],
      projectHostSetups: [setup({ id: 's-a', repoId: 'repoA', hostId: RUNTIME_A })],
      worktreesByRepo: {
        repoA: [makeWorktree({ id: worktreeId, repoId: 'repoA', hostId: undefined })]
      },
      tabsByWorktree: { [worktreeId]: [makeTab({ id: 'legacy-tab', worktreeId })] }
    })

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    const s = store.getState()
    expect(s.projectHostSetups).toEqual([])
    expect(s.worktreesByRepo.repoA).toEqual([])
    expect(s.tabsByWorktree[worktreeId]).toBeUndefined()
  })

  it('purges hydrated worktree state before its worktree row loads', () => {
    const store = createTestStore()
    const worktreeId = 'repoA::/session-only'
    seedStore(store, {
      repos: [
        {
          id: 'repoA',
          path: '/repoA',
          displayName: 'A',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: RUNTIME_A
        }
      ],
      worktreesByRepo: {},
      tabsByWorktree: { [worktreeId]: [makeTab({ id: 'hydrated-tab', worktreeId })] },
      activeWorktreeId: worktreeId,
      activeWorkspaceKey: worktreeWorkspaceKey(worktreeId)
    })

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    const s = store.getState()
    expect(s.tabsByWorktree[worktreeId]).toBeUndefined()
    expect(s.activeWorktreeId).toBeNull()
    expect(s.activeWorkspaceKey).toBeNull()
  })

  it('uses an explicit surviving worktree row as owner evidence during catalog loading', () => {
    const store = createTestStore()
    const RUNTIME_B = toRuntimeExecutionHostId('env-b')
    const legacyWorktreeId = 'shared::/legacy'
    const survivingWorktreeId = 'shared::/host-b'
    const tabs = [makeTab({ id: 'surviving-tab', worktreeId: legacyWorktreeId })]
    seedStore(store, {
      repos: [
        {
          id: 'shared',
          path: '/shared-a',
          displayName: 'A',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: RUNTIME_A
        }
      ],
      worktreesByRepo: {
        shared: [makeWorktree({ id: legacyWorktreeId, repoId: 'shared', hostId: undefined })]
      },
      detectedWorktreesByRepo: {
        shared: detectedResult('shared', [detected(survivingWorktreeId, 'shared', RUNTIME_B)])
      },
      tabsByWorktree: { [legacyWorktreeId]: tabs }
    })

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    const s = store.getState()
    expect(s.repos).toEqual([])
    expect(s.worktreesByRepo.shared.map((worktree) => worktree.id)).toEqual([legacyWorktreeId])
    expect(s.detectedWorktreesByRepo.shared.worktrees.map((worktree) => worktree.id)).toEqual([
      survivingWorktreeId
    ])
    expect(s.tabsByWorktree[legacyWorktreeId]).toBe(tabs)
  })

  it('preserves an unhosted row when a setup proves another host still owns it', () => {
    const store = createTestStore()
    const RUNTIME_B = toRuntimeExecutionHostId('env-b')
    const worktreeId = 'shared::/legacy'
    const tabs = [makeTab({ id: 'surviving-tab', worktreeId })]
    seedStore(store, {
      repos: [
        {
          id: 'shared',
          path: '/shared-a',
          displayName: 'A',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: RUNTIME_A
        }
      ],
      projectHostSetups: [setup({ id: 's-b', repoId: 'shared', hostId: RUNTIME_B })],
      worktreesByRepo: {
        shared: [makeWorktree({ id: worktreeId, repoId: 'shared', hostId: undefined })]
      },
      tabsByWorktree: { [worktreeId]: tabs }
    })

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    const s = store.getState()
    expect(s.repos).toEqual([])
    expect(s.projectHostSetups).toHaveLength(1)
    expect(s.worktreesByRepo.shared).toHaveLength(1)
    expect(s.tabsByWorktree[worktreeId]).toBe(tabs)
  })

  it('purges a legacy unhosted row when every repo owner is removed together', () => {
    const store = createTestStore()
    const RUNTIME_B = toRuntimeExecutionHostId('env-b')
    const worktreeId = 'shared::/legacy'
    seedStore(store, {
      repos: [
        {
          id: 'shared',
          path: '/shared-a',
          displayName: 'A',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: RUNTIME_A
        },
        {
          id: 'shared',
          path: '/shared-b',
          displayName: 'B',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: RUNTIME_B
        }
      ],
      worktreesByRepo: {
        shared: [makeWorktree({ id: worktreeId, repoId: 'shared', hostId: undefined })]
      },
      detectedWorktreesByRepo: {
        shared: detectedResult('shared', [detected(worktreeId, 'shared', undefined)])
      },
      tabsByWorktree: { [worktreeId]: [makeTab({ id: 'legacy-tab', worktreeId })] }
    })

    store.getState().purgeStaleRuntimeHostState(['env-a', 'env-b'])

    const s = store.getState()
    expect(s.repos).toEqual([])
    expect(s.worktreesByRepo.shared).toEqual([])
    expect(s.detectedWorktreesByRepo.shared.worktrees).toEqual([])
    expect(s.tabsByWorktree[worktreeId]).toBeUndefined()
  })

  it('clears activeRepoId and drops the purged id from filterRepoIds', () => {
    const store = createTestStore()
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
        repoA: [makeWorktree({ id: 'repoA::/wt-a', repoId: 'repoA', hostId: RUNTIME_A })]
      },
      activeRepoId: 'repoA',
      filterRepoIds: ['repo1', 'repoA']
    })

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    const s = store.getState()
    expect(s.activeRepoId).toBeNull()
    expect(s.filterRepoIds).toEqual(['repo1'])
  })
})
