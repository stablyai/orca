/** Scope purge to removed runtime identities (#8881); retire owned catalog/tabs/detection while preserving local/SSH and never-saved runtime-stamped serving-local rows. Empty/unmatched diffs keep identity/epoch. */
import { describe, it, expect, vi } from 'vitest'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { DetectedWorktreeListResult } from '../../../../shared/worktree/types'

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
import { registerPendingEditorFlush } from '@/components/editor/editor-pending-flush'

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
      // Include never-saved runtime-stamped LOCAL row beside real removed runtime and local repos.
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
      endpointProjectHostSetups: [
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
    expect(s.repos.map((r) => r.id)).toEqual(['repo1', 'repoServing'])
    expect(s.endpointProjectHostSetups.map((x) => x.id).sort()).toEqual(['s-local', 's-serving'])
    expect(s.worktreesByRepo.repoA).toEqual([])
    expect(s.detectedWorktreesByRepo.repoA.worktrees).toEqual([])
    expect(s.tabsByWorktree[WT_A]).toBeUndefined()
    expect(s.worktreesByRepo.repo1).toHaveLength(1)
    expect(s.worktreesByRepo.repoServing).toHaveLength(1)
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
      endpointProjectHostSetups: [setup({ id: 's-local', repoId: 'repo1', hostId: 'local' })],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: 'repo1::/wt', repoId: 'repo1', hostId: 'local' })]
      }
    })
    const before = store.getState()
    const epochBefore = before.sortEpoch
    const worktreesRef = before.worktreesByRepo
    const reposRef = before.repos
    const setupsRef = before.endpointProjectHostSetups

    store.getState().purgeStaleRuntimeHostState([])
    store.getState().purgeStaleRuntimeHostState(['env-does-not-exist'])

    const s = store.getState()
    expect(s.sortEpoch).toBe(epochBefore)
    // Nothing stale => the reducer returns state untouched (same references).
    expect(s.worktreesByRepo).toBe(worktreesRef)
    expect(s.repos).toBe(reposRef)
    expect(s.endpointProjectHostSetups).toBe(setupsRef)
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
      lastVisitedAtByWorktreeId: {
        [worktreeId]: 50,
        [`${RUNTIME_A}|${worktreeId}`]: 100,
        [`${RUNTIME_B}|${worktreeId}`]: 200
      },
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
    expect(s.lastVisitedAtByWorktreeId).toEqual({
      [worktreeId]: 50,
      [`${RUNTIME_B}|${worktreeId}`]: 200
    })
    expect(s.restoredRuntimeHostIdByWorkspaceSessionKey).toBe(restoredOwners)
    expect(s.restoredRuntimeHostIdByWorkspaceSessionKey[worktreeId]).toBe(RUNTIME_B)
    expect(s.activeWorktreeId).toBe(worktreeId)
    expect(s.activeWorkspaceKey).toBe(worktreeWorkspaceKey(worktreeId))
  })

  it('flushes delayed editor text of the removed host before purging its tabs', () => {
    const store = createTestStore()
    const worktreeId = 'repoA::/wt-flush'
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
        repoA: [makeWorktree({ id: worktreeId, repoId: 'repoA', hostId: RUNTIME_A })]
      }
    })
    store.getState().openFile({
      filePath: '/repoA/wt-flush/a.md',
      relativePath: 'a.md',
      worktreeId,
      language: 'markdown',
      mode: 'edit'
    })
    const fileId = store.getState().openFiles[0].id
    const flush = vi.fn()
    const unregister = registerPendingEditorFlush(fileId, flush)

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    expect(flush).toHaveBeenCalledTimes(1)
    unregister()
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
      endpointProjectHostSetups: [setup({ id: 's-a', repoId: 'repoA', hostId: RUNTIME_A })],
      worktreesByRepo: {
        repoA: [makeWorktree({ id: worktreeId, repoId: 'repoA', hostId: undefined })]
      },
      tabsByWorktree: { [worktreeId]: [makeTab({ id: 'legacy-tab', worktreeId })] }
    })

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    const s = store.getState()
    expect(s.endpointProjectHostSetups).toEqual([])
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
      endpointProjectHostSetups: [setup({ id: 's-b', repoId: 'shared', hostId: RUNTIME_B })],
      worktreesByRepo: {
        shared: [makeWorktree({ id: worktreeId, repoId: 'shared', hostId: undefined })]
      },
      tabsByWorktree: { [worktreeId]: tabs }
    })

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    const s = store.getState()
    expect(s.repos).toEqual([])
    expect(s.endpointProjectHostSetups).toHaveLength(1)
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

  it('purges visibility state even when the removed host has no catalog rows', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreeVisibilityDefaultsByHost: {
        local: { external: 'hide' },
        [RUNTIME_A]: { external: 'show' }
      },
      worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId: 'env-a',
      worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId: 'env-a'
    })

    store.getState().purgeStaleRuntimeHostState(['env-a'])

    expect(store.getState().worktreeVisibilityDefaultsByHost).toEqual({
      local: { external: 'hide' }
    })
    expect(store.getState().worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId).toBeNull()
    expect(
      store.getState().worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId
    ).toBeNull()
  })
})
