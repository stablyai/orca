import { createStore } from 'zustand/vanilla'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostLineageSnapshot } from '../../../shared/host-lineage-contract'
import type { HostRepoCatalogSnapshot } from '../../../shared/host-repo-catalog-contract'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import type { Repo } from '../../../shared/repo-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../shared/worktree/lineage-types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { AppState } from '../store/types'
import { createDirectSshHostHydration } from './direct-ssh-host-hydration'

function authority(targetId = 'target-a', epoch = 'epoch-a'): DirectSshAuthority {
  return {
    targetId,
    providerEpoch: epoch as SshProviderEpoch,
    connectionGeneration: 1
  }
}

function repo(id: string, targetId: string | null): Repo {
  return {
    id,
    path: targetId ? `/${targetId}/${id}` : `/local/${id}`,
    projectGroupId: null,
    connectionId: targetId,
    executionHostId: targetId ? (`ssh:${targetId}` as const) : ('local' as const)
  } as Repo
}

function state(overrides: Record<string, unknown> = {}): AppState {
  return {
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    worktreeLineageById: {},
    workspaceLineageByChildKey: {},
    ...overrides
  } as unknown as AppState
}

function productionLineage(worktreeId: string, parentWorktreeId: string): WorktreeLineage {
  return {
    worktreeId,
    worktreeInstanceId: `${worktreeId}-instance`,
    parentWorktreeId,
    parentWorktreeInstanceId: `${parentWorktreeId}-instance`,
    origin: 'orchestration',
    capture: { source: 'orchestration-context', confidence: 'explicit' },
    taskId: 'task-1',
    coordinatorHandle: 'coord-1',
    createdAt: 1
  }
}

function productionWorkspaceLineage(childId: string, parentId: string): WorkspaceLineage {
  return {
    childWorkspaceKey: worktreeWorkspaceKey(childId),
    childInstanceId: `${childId}-instance`,
    parentWorkspaceKey: worktreeWorkspaceKey(parentId),
    parentInstanceId: `${parentId}-instance`,
    origin: 'orchestration',
    capture: { source: 'orchestration-context', confidence: 'explicit' },
    taskId: 'task-1',
    coordinatorHandle: 'coord-1',
    createdAt: 1
  }
}

function hostSnapshot(
  owner: DirectSshAuthority,
  repos: ReturnType<typeof repo>[]
): HostRepoCatalogSnapshot {
  return {
    authoritative: true as const,
    authority: {
      kind: 'direct-ssh' as const,
      executionHostId: `ssh:${owner.targetId}` as const,
      ...owner
    },
    repos
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createDirectSshHostHydration', () => {
  it('replaces only the exact SSH host catalog when repo IDs collide', async () => {
    const owner = authority()
    const store = createStore<AppState>(() =>
      state({
        repos: [repo('shared', null), repo('shared', 'target-a'), repo('shared', 'target-b')]
      })
    )
    const hydration = createDirectSshHostHydration({
      store,
      listRepos: vi.fn(async () => hostSnapshot(owner, [repo('shared', 'target-a')])),
      listLineage: vi.fn(),
      isCurrentAuthority: () => true
    })

    const input = await hydration.capturePreparationInput(owner, 'reconnect')

    expect(input?.repoRefs).toEqual([{ repoId: 'shared', executionHostId: 'ssh:target-a' }])
    expect(store.getState().repos).toEqual([
      repo('shared', null),
      repo('shared', 'target-b'),
      repo('shared', 'target-a')
    ])
  })

  it('rejects a mismatched host response without publishing', async () => {
    const owner = authority()
    const store = createStore<AppState>(() => state({ repos: [repo('cached', 'target-a')] }))
    const before = store.getState().repos
    let publications = 0
    store.subscribe(() => {
      publications += 1
    })
    const hydration = createDirectSshHostHydration({
      store,
      listRepos: vi.fn(async () =>
        hostSnapshot(authority('target-b', 'epoch-b'), [repo('wrong', 'target-b')])
      ),
      listLineage: vi.fn(),
      isCurrentAuthority: () => true
    })

    await expect(hydration.capturePreparationInput(owner, 'wake-refresh')).resolves.toBeNull()
    expect(store.getState().repos).toBe(before)
    expect(publications).toBe(0)
  })

  it('settles a non-cooperative catalog read at five seconds and clears its timer', async () => {
    vi.useFakeTimers()
    const owner = authority()
    const store = createStore<AppState>(() => state({ repos: [repo('cached', 'target-a')] }))
    let resolveLate!: (value: HostRepoCatalogSnapshot) => void
    const lateSnapshot = new Promise<HostRepoCatalogSnapshot>((resolve) => {
      resolveLate = resolve
    })
    let publications = 0
    store.subscribe(() => {
      publications += 1
    })
    const hydration = createDirectSshHostHydration({
      store,
      listRepos: vi.fn(() => lateSnapshot),
      listLineage: vi.fn(),
      isCurrentAuthority: () => true
    })

    const pending = hydration.capturePreparationInput(owner, 'wake-refresh')
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toMatchObject({
      catalogRevision: 0,
      repoRefs: [{ repoId: 'cached', executionHostId: 'ssh:target-a' }]
    })
    expect(vi.getTimerCount()).toBe(0)
    resolveLate(hostSnapshot(owner, [repo('late', 'target-a')]))
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getState().repos).toEqual([repo('cached', 'target-a')])
    expect(publications).toBe(0)
  })

  it('discards a catalog reply after authority changes with zero mutation', async () => {
    const owner = authority()
    const store = createStore<AppState>(() => state({ repos: [repo('cached', 'target-a')] }))
    let current = true
    let resolve!: (value: ReturnType<typeof hostSnapshot>) => void
    const pendingSnapshot = new Promise<HostRepoCatalogSnapshot>((settle) => {
      resolve = settle
    })
    let publications = 0
    store.subscribe(() => {
      publications += 1
    })
    const hydration = createDirectSshHostHydration({
      store,
      listRepos: () => pendingSnapshot,
      listLineage: vi.fn(),
      isCurrentAuthority: () => current
    })

    const pending = hydration.capturePreparationInput(owner, 'reconnect')
    current = false
    resolve(hostSnapshot(owner, [repo('new', 'target-a')]))

    await expect(pending).resolves.toBeNull()
    expect(store.getState().repos).toEqual([repo('cached', 'target-a')])
    expect(publications).toBe(0)
  })

  it('settles pending host reads and clears their timers on stop', async () => {
    vi.useFakeTimers()
    const owner = authority()
    const store = createStore<AppState>(() => state())
    const hydration = createDirectSshHostHydration({
      store,
      listRepos: () => new Promise<HostRepoCatalogSnapshot>(() => {}),
      listLineage: vi.fn(),
      isCurrentAuthority: () => true
    })

    const pending = hydration.capturePreparationInput(owner, 'wake-refresh')
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(1)
    hydration.stop()

    await expect(pending).resolves.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('replaces only exact-host Git and folder lineage across both key namespaces', async () => {
    const owner = authority()
    const store = createStore<AppState>(() =>
      state({
        repos: [
          repo('a', 'target-a'),
          repo('b', 'target-b'),
          repo('ambiguous', 'target-a'),
          repo('ambiguous', 'target-a'),
          repo('contradictory', 'target-a')
        ],
        worktreesByRepo: {
          a: [{ id: 'a::/work', repoId: 'a', hostId: 'ssh:target-a' }],
          b: [{ id: 'b::/work', repoId: 'b', hostId: 'ssh:target-b' }],
          ambiguous: [
            {
              id: 'ambiguous::/work',
              repoId: 'ambiguous',
              hostId: 'ssh:target-a'
            }
          ],
          contradictory: [
            {
              id: 'contradictory::/work',
              repoId: 'contradictory',
              hostId: 'ssh:target-b'
            }
          ]
        },
        projectGroups: [
          {
            id: 'group-a',
            parentGroupId: null,
            connectionId: 'target-a',
            executionHostId: 'ssh:target-a'
          },
          {
            id: 'group-b',
            parentGroupId: null,
            connectionId: 'target-b',
            executionHostId: 'ssh:target-b'
          }
        ],
        folderWorkspaces: [
          {
            id: 'folder-a',
            projectGroupId: 'group-a',
            folderPath: '/target-a/folder',
            connectionId: 'target-a'
          },
          {
            id: 'folder-b',
            projectGroupId: 'group-b',
            folderPath: '/target-b/folder',
            connectionId: 'target-b'
          }
        ],
        worktreeLineageById: {
          'a::/work': { parentWorktreeId: 'stale-a' },
          'b::/work': { parentWorktreeId: 'keep-b' },
          'ambiguous::/work': { parentWorktreeId: 'keep-ambiguous' },
          'contradictory::/work': { parentWorktreeId: 'keep-contradictory' }
        },
        workspaceLineageByChildKey: {
          [worktreeWorkspaceKey('a::/work')]: { parentWorkspaceKey: 'stale-a-workspace' },
          [worktreeWorkspaceKey('b::/work')]: { parentWorkspaceKey: 'keep-b-workspace' },
          [worktreeWorkspaceKey('ambiguous::/work')]: {
            parentWorkspaceKey: 'keep-ambiguous-workspace'
          },
          [worktreeWorkspaceKey('contradictory::/work')]: {
            parentWorkspaceKey: 'keep-contradictory-workspace'
          },
          [folderWorkspaceKey('folder-a')]: { parentWorkspaceKey: 'stale-folder' },
          [folderWorkspaceKey('folder-b')]: { parentWorkspaceKey: 'keep-folder-b' }
        }
      })
    )
    const hydration = createDirectSshHostHydration({
      store,
      listRepos: vi.fn(),
      listLineage: vi.fn(
        async () =>
          ({
            authoritative: true,
            authority: {
              kind: 'direct-ssh',
              executionHostId: 'ssh:target-a',
              ...owner
            },
            worktreeLineageById: {
              'a::/work': { parentWorktreeId: 'fresh-a' },
              'b::/work': { parentWorktreeId: 'foreign-overwrite' },
              'ambiguous::/work': { parentWorktreeId: 'ambiguous-overwrite' },
              'contradictory::/work': { parentWorktreeId: 'contradictory-overwrite' }
            },
            workspaceLineageByChildKey: {
              'a::/work': { parentWorkspaceKey: 'raw-terminal-key-must-not-enter-lineage' },
              [worktreeWorkspaceKey('a::/work')]: {
                parentWorkspaceKey: 'fresh-a-workspace'
              },
              [worktreeWorkspaceKey('b::/work')]: {
                parentWorkspaceKey: 'foreign-workspace-overwrite'
              },
              [worktreeWorkspaceKey('ambiguous::/work')]: {
                parentWorkspaceKey: 'ambiguous-workspace-overwrite'
              },
              [worktreeWorkspaceKey('contradictory::/work')]: {
                parentWorkspaceKey: 'contradictory-workspace-overwrite'
              },
              [folderWorkspaceKey('folder-a')]: { parentWorkspaceKey: 'fresh-folder' },
              [folderWorkspaceKey('folder-b')]: {
                parentWorkspaceKey: 'foreign-folder-overwrite'
              }
            }
          }) as unknown as HostLineageSnapshot
      ),
      isCurrentAuthority: () => true
    })

    await expect(
      hydration.readHostScopedLineage({
        ...owner,
        catalogRevision: 0,
        repoRefs: [{ repoId: 'a', executionHostId: 'ssh:target-a' }],
        authorityRequirement: 'required',
        reason: 'reconnect'
      })
    ).resolves.toBe('complete')
    expect(store.getState().worktreeLineageById).toEqual({
      'a::/work': { parentWorktreeId: 'fresh-a' },
      'b::/work': { parentWorktreeId: 'keep-b' },
      'ambiguous::/work': { parentWorktreeId: 'keep-ambiguous' },
      'contradictory::/work': { parentWorktreeId: 'keep-contradictory' }
    })
    expect(store.getState().workspaceLineageByChildKey).toEqual({
      [worktreeWorkspaceKey('b::/work')]: { parentWorkspaceKey: 'keep-b-workspace' },
      [worktreeWorkspaceKey('ambiguous::/work')]: {
        parentWorkspaceKey: 'keep-ambiguous-workspace'
      },
      [worktreeWorkspaceKey('contradictory::/work')]: {
        parentWorkspaceKey: 'keep-contradictory-workspace'
      },
      [folderWorkspaceKey('folder-b')]: { parentWorkspaceKey: 'keep-folder-b' },
      [worktreeWorkspaceKey('a::/work')]: { parentWorkspaceKey: 'fresh-a-workspace' },
      [folderWorkspaceKey('folder-a')]: { parentWorkspaceKey: 'fresh-folder' }
    })
  })

  it('keeps lineage map identity for a cloned no-op host snapshot', async () => {
    const owner = authority()
    const hostLineage = productionLineage('a::/work', 'a::/parent')
    const foreignLineage = productionLineage('b::/work', 'b::/parent')
    const hostWorkspace = productionWorkspaceLineage('a::/work', 'a::/parent')
    const foreignWorkspace = productionWorkspaceLineage('b::/work', 'b::/parent')
    const store = createStore<AppState>(() =>
      state({
        repos: [repo('a', 'target-a'), repo('b', 'target-b')],
        worktreesByRepo: {
          a: [{ id: 'a::/work', repoId: 'a', hostId: 'ssh:target-a' }],
          b: [{ id: 'b::/work', repoId: 'b', hostId: 'ssh:target-b' }]
        },
        worktreeLineageById: {
          'a::/work': hostLineage,
          'b::/work': foreignLineage
        },
        workspaceLineageByChildKey: {
          [worktreeWorkspaceKey('a::/work')]: hostWorkspace,
          [worktreeWorkspaceKey('b::/work')]: foreignWorkspace
        }
      })
    )
    const snapshot: HostLineageSnapshot = {
      authoritative: true,
      authority: {
        kind: 'direct-ssh',
        executionHostId: 'ssh:target-a',
        ...owner
      },
      worktreeLineageById: {
        'a::/work': hostLineage
      },
      workspaceLineageByChildKey: {
        [worktreeWorkspaceKey('a::/work')]: hostWorkspace
      }
    }
    let publications = 0
    store.subscribe(() => {
      publications += 1
    })
    const hydration = createDirectSshHostHydration({
      store,
      listRepos: vi.fn(),
      listLineage: vi.fn(async () => structuredClone(snapshot)),
      isCurrentAuthority: () => true
    })
    const beforeLineage = store.getState().worktreeLineageById
    const beforeWorkspace = store.getState().workspaceLineageByChildKey

    await expect(
      hydration.readHostScopedLineage({
        ...owner,
        catalogRevision: 0,
        repoRefs: [{ repoId: 'a', executionHostId: 'ssh:target-a' }],
        authorityRequirement: 'required',
        reason: 'reconnect'
      })
    ).resolves.toBe('complete')

    expect(store.getState().worktreeLineageById).toBe(beforeLineage)
    expect(store.getState().workspaceLineageByChildKey).toBe(beforeWorkspace)
    expect(store.getState().worktreeLineageById['a::/work']).toBe(hostLineage)
    expect(store.getState().worktreeLineageById['b::/work']).toBe(foreignLineage)
    expect(store.getState().workspaceLineageByChildKey[worktreeWorkspaceKey('a::/work')]).toBe(
      hostWorkspace
    )
    expect(store.getState().workspaceLineageByChildKey[worktreeWorkspaceKey('b::/work')]).toBe(
      foreignWorkspace
    )
    expect(publications).toBe(0)
  })

  it('rejects lineage captured before a newer same-authority catalog revision', async () => {
    const owner = authority()
    const store = createStore<AppState>(() =>
      state({
        repos: [repo('a', 'target-a')],
        worktreesByRepo: {
          a: [{ id: 'a::/work', repoId: 'a', hostId: 'ssh:target-a' }]
        },
        worktreeLineageById: {
          'a::/work': { parentWorktreeId: 'keep-current' }
        }
      })
    )
    let resolveLineage!: (value: HostLineageSnapshot) => void
    const pendingLineage = new Promise<HostLineageSnapshot>((resolve) => {
      resolveLineage = resolve
    })
    const hydration = createDirectSshHostHydration({
      store,
      listRepos: vi.fn(async () => hostSnapshot(owner, [repo('a', 'target-a')])),
      listLineage: () => pendingLineage,
      isCurrentAuthority: () => true
    })
    const firstInput = await hydration.capturePreparationInput(owner, 'reconnect')
    if (!firstInput) {
      throw new Error('Expected first preparation input')
    }
    const pending = hydration.readHostScopedLineage(firstInput)
    await hydration.capturePreparationInput(owner, 'wake-refresh')
    const beforeLateLineage = store.getState().worktreeLineageById
    resolveLineage({
      authoritative: true,
      authority: {
        kind: 'direct-ssh',
        executionHostId: 'ssh:target-a',
        ...owner
      },
      worktreeLineageById: {
        'a::/work': { parentWorktreeId: 'stale-overwrite' }
      },
      workspaceLineageByChildKey: {}
    } as unknown as HostLineageSnapshot)

    await expect(pending).resolves.toBe('stale')
    expect(store.getState().worktreeLineageById).toBe(beforeLateLineage)
  })
})
