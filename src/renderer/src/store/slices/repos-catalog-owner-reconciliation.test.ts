import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FLOATING_TERMINAL_WORKTREE_ID,
  getDefaultWorkspaceSession
} from '../../../../shared/constants'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { getWorktreeVisitKey } from '../../lib/worktree-visit-recency'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from '../../lib/workspace-session-host-hydration'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createWebWorkspaceSessionApi } from '../../web/preload-api/web-workspace-session-api'
import { buildRuntimeSessionPlaceholders } from '../terminals/workspace-terminal-placeholders'
import { registerPendingEditorFlush } from '../../components/editor/editor-pending-flush'
import {
  createTestStore,
  makeOpenFile,
  makeTab,
  makeUnifiedTab,
  makeWorktree
} from './store-test-helpers'

const sshState = vi.hoisted(() => ({ generation: 0 }))
vi.mock('./runtime-environment-ssh', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getEnvironmentSshStateGeneration: () => sshState.generation
}))
vi.mock('../../web/preload-api/web-runtime-session', () => ({
  requireActiveEnvironmentOrNull: () => null
}))

const localList = vi.fn()
const remoteList = vi.fn()
const kill = vi.fn()
const id = 'repo::/work/repo'
const repoId = 'repo'
type Store = ReturnType<typeof createTestStore>
type Loader = 'local' | 'runtime' | 'all-hosts'

function repo(hostId: ExecutionHostId): Repo {
  return {
    id: repoId,
    path: '/work/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 1,
    executionHostId: hostId
  }
}

function seedOwner(store: Store, hostId: ExecutionHostId, rows = true): void {
  const worktree = makeWorktree({ id, repoId, hostId, path: '/work/repo' })
  store.setState({
    repos: rows ? [repo(hostId)] : [],
    worktreesByRepo: rows ? { [repoId]: [worktree] } : {},
    detectedWorktreesByRepo: rows
      ? {
          [repoId]: {
            repoId,
            worktrees: [
              { ...worktree, ownership: 'orca-managed', selectedCheckout: true, visible: true }
            ],
            authoritative: true,
            source: 'git'
          }
        }
      : {},
    activeRepoId: repoId,
    activeWorktreeId: id,
    activeWorkspaceKey: worktreeWorkspaceKey(id),
    activeWorkspaceExecutionHostId: hostId,
    lastVisitedAtByWorktreeId: { [getWorktreeVisitKey(id, hostId)]: 42 },
    restoredRuntimeHostIdByWorkspaceSessionKey: hostId === 'local' ? {} : { [id]: hostId },
    tabsByWorktree: rows
      ? {
          [id]: [
            makeTab({
              id: 'tab',
              worktreeId: id,
              ptyId:
                hostId === 'local'
                  ? 'pty'
                  : `${hostId.startsWith('runtime:') ? `remote:${hostId.slice(8)}` : hostId}@@pty`
            })
          ]
        }
      : {}
  })
}

async function load(store: Store, loader: Loader): Promise<void> {
  if (loader === 'local') {
    return store.getState().fetchRepos({ runtimeEnvironmentId: null })
  }
  if (loader === 'runtime') {
    await store.getState().fetchRuntimeEnvironmentRepos('env-1')
    return
  }
  return store.getState().fetchReposForAllHosts()
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  sshState.generation = 0
  localList.mockReset().mockResolvedValue([])
  remoteList.mockReset().mockResolvedValue([])
  kill.mockReset().mockResolvedValue(undefined)
  const storage = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size
    }
  }
  vi.stubGlobal('localStorage', localStorage)
  vi.stubGlobal('window', {
    localStorage,
    api: {
      repos: { list: localList },
      pty: { kill },
      projects: {
        list: vi.fn().mockResolvedValue([]),
        listHostSetups: vi.fn().mockResolvedValue([])
      },
      runtimeEnvironments: {
        list: vi.fn().mockResolvedValue([{ id: 'env-1', name: 'Remote' }]),
        call: async (args: RuntimeEnvironmentCallRequest) => {
          const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
          if (compatible) {
            return compatible
          }
          return {
            id: 'rpc',
            ok: true,
            result:
              args.method === 'repo.list'
                ? { repos: await remoteList() }
                : { projects: [], setups: [] },
            _meta: { runtimeId: 'remote-runtime' }
          }
        }
      }
    },
    dispatchEvent: vi.fn()
  })
})

describe('accepted repo catalogs reconcile workspace owners', () => {
  it('runtime deletion preserves a live local session-only sibling before listing hydration', async () => {
    const store = createTestStore()
    seedOwner(store, 'runtime:env-1', false)
    const tab = makeTab({ id: 'local-sibling', worktreeId: id, ptyId: 'local-pty' })
    store.setState({
      repos: [repo('local')],
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      tabsByWorktree: { [id]: [tab] },
      ptyIdsByTabId: { [tab.id]: ['local-pty'] }
    })
    await load(store, 'runtime')
    expect(store.getState().tabsByWorktree[id]).toEqual([tab])
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({})
  })

  for (const contentType of ['terminal', 'agent-session', 'browser'] as const) {
    it(`preserves a stamped ${contentType} sibling without worktree rows or sibling history`, async () => {
      const store = createTestStore()
      seedOwner(store, 'runtime:env-1', false)
      const tab = makeUnifiedTab({
        id: 'sibling',
        worktreeId: id,
        groupId: 'group',
        contentType,
        executionHostId: 'local'
      })
      store.setState({
        activeWorktreeId: null,
        activeWorkspaceExecutionHostId: null,
        unifiedTabsByWorktree: { [id]: [tab] }
      })
      await load(store, 'runtime')
      expect(store.getState().unifiedTabsByWorktree[id]).toEqual([tab])
      expect(store.getState().lastVisitedAtByWorktreeId).toEqual({})
    })
  }

  for (const loader of ['local', 'runtime', 'all-hosts'] as const) {
    const hostId = loader === 'local' ? 'local' : 'runtime:env-1'
    it(`${loader}: successful empty removes rows, selection and qualified history without killing PTYs`, async () => {
      const store = createTestStore()
      seedOwner(store, hostId)

      await load(store, loader)

      const state = store.getState()
      expect(state.repos).toEqual([])
      expect(state.worktreesByRepo[repoId] ?? []).toEqual([])
      expect(state.detectedWorktreesByRepo[repoId]?.worktrees ?? []).toEqual([])
      expect(state.lastVisitedAtByWorktreeId).toEqual({})
      expect(state.activeWorktreeId).toBeNull()
      expect(state.activeWorkspaceKey).toBeNull()
      expect(state.activeWorkspaceExecutionHostId).toBeNull()
      expect(state.tabsByWorktree[id]).toBeUndefined()
      expect(kill).not.toHaveBeenCalled()
    })

    it(`${loader}: removes qualified persisted-only references without prior catalog rows`, async () => {
      const store = createTestStore()
      seedOwner(store, hostId, false)

      await load(store, loader)

      expect(store.getState().lastVisitedAtByWorktreeId).toEqual({})
      expect(store.getState().activeWorktreeId).toBeNull()
      expect(store.getState().restoredRuntimeHostIdByWorkspaceSessionKey[id]).toBeUndefined()
    })
  }

  it('persists cleared web history and rehydrates without rebuilding a removed runtime placeholder', async () => {
    const store = createTestStore()
    seedOwner(store, 'runtime:env-1', false)
    await load(store, 'runtime')
    const api = createWebWorkspaceSessionApi().session
    expect(api).toBeDefined()
    if (!api) {
      throw new Error('Missing web session API')
    }
    const state = store.getState()
    await api.set(
      {
        ...getDefaultWorkspaceSession(),
        activeWorktreeId: state.activeWorktreeId,
        lastVisitedAtByWorktreeId: state.lastVisitedAtByWorktreeId
      },
      'runtime:env-1'
    )

    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(api, [], ['runtime:env-1'])
    const hydrated = buildRuntimeSessionPlaceholders({
      repos: [],
      worktreesByRepo: {},
      runtimeHostIdByWorkspaceSessionKey: read.runtimeHostIdByWorkspaceSessionKey
    })

    expect(read.session.lastVisitedAtByWorktreeId).toEqual({})
    expect(read.session.activeWorktreeId).toBeNull()
    expect(hydrated.repos).toEqual([])
    expect(hydrated.worktreesByRepo).toEqual({})
  })

  it('removes only the local twin and preserves runtime tabs, active host and bare ambiguous history', async () => {
    const store = createTestStore()
    seedOwner(store, 'local')
    const remoteWorktree = makeWorktree({ id, repoId, hostId: 'runtime:env-1' })
    const remoteTab = makeTab({ id: 'remote-tab', worktreeId: id, ptyId: 'remote:env-1@@pty' })
    store.setState({
      repos: [repo('local'), repo('runtime:env-1')],
      worktreesByRepo: {
        [repoId]: [...(store.getState().worktreesByRepo[repoId] ?? []), remoteWorktree]
      },
      activeWorkspaceExecutionHostId: 'runtime:env-1',
      activeTabId: remoteTab.id,
      tabsByWorktree: {
        [id]: [makeTab({ id: 'local-tab', worktreeId: id, ptyId: 'local-pty' }), remoteTab]
      },
      lastVisitedAtByWorktreeId: {
        [getWorktreeVisitKey(id, 'local')]: 1,
        [getWorktreeVisitKey(id, 'runtime:env-1')]: 2,
        [id]: 3
      }
    })

    await load(store, 'local')

    const state = store.getState()
    expect(state.worktreesByRepo[repoId]).toEqual([remoteWorktree])
    expect(state.tabsByWorktree[id]).toContainEqual(remoteTab)
    expect(state.activeWorktreeId).toBe(id)
    expect(state.activeTabId).toBe(remoteTab.id)
    expect(state.activeWorkspaceExecutionHostId).toBe('runtime:env-1')
    expect(state.lastVisitedAtByWorktreeId).toEqual({
      [getWorktreeVisitKey(id, 'runtime:env-1')]: 2,
      [id]: 3
    })
  })

  it('a local-only first-paint catalog preserves unrequested runtime-only history', async () => {
    const store = createTestStore()
    seedOwner(store, 'runtime:env-1', false)

    await store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })

    expect(remoteList).not.toHaveBeenCalled()
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({
      [getWorktreeVisitKey(id, 'runtime:env-1')]: 42
    })
    expect(store.getState().activeWorktreeId).toBe(id)
  })

  for (const loader of ['runtime', 'all-hosts'] as const) {
    it(`${loader}: failed owner catalog preserves rows and qualified history`, async () => {
      remoteList.mockRejectedValue(new Error('offline'))
      const store = createTestStore()
      seedOwner(store, 'runtime:env-1')

      await load(store, loader)

      expect(store.getState().worktreesByRepo[repoId]).toHaveLength(1)
      expect(store.getState().lastVisitedAtByWorktreeId).toEqual({
        [getWorktreeVisitKey(id, 'runtime:env-1')]: 42
      })
      expect(store.getState().activeWorktreeId).toBe(id)
    })

    it(`${loader}: replaced-connection empty catalog cannot purge its former owner`, async () => {
      const result = Promise.withResolvers<Repo[]>()
      const started = Promise.withResolvers<void>()
      remoteList.mockImplementation(() => {
        started.resolve()
        return result.promise
      })
      const store = createTestStore()
      seedOwner(store, 'runtime:env-1')
      const pending = load(store, loader)
      await started.promise
      sshState.generation += 1
      result.resolve([])
      await pending

      expect(store.getState().worktreesByRepo[repoId]).toHaveLength(1)
      expect(store.getState().lastVisitedAtByWorktreeId).toEqual({
        [getWorktreeVisitKey(id, 'runtime:env-1')]: 42
      })
      expect(store.getState().activeWorktreeId).toBe(id)
    })
  }

  it('local catalog absence preserves a direct SSH owner and its workspace state', async () => {
    const store = createTestStore()
    seedOwner(store, 'ssh:direct')
    store.setState({ repos: [{ ...repo('ssh:direct'), connectionId: 'direct' }] })

    await load(store, 'local')

    expect(store.getState().repos).toHaveLength(1)
    expect(store.getState().worktreesByRepo[repoId]).toHaveLength(1)
    expect(store.getState().activeWorkspaceExecutionHostId).toBe('ssh:direct')
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({
      [getWorktreeVisitKey(id, 'ssh:direct')]: 42
    })
  })

  it('local catalog absence preserves nested SSH workspaces owned by an untouched runtime', async () => {
    const store = createTestStore()
    seedOwner(store, 'ssh:nested')
    store.setState({
      repos: [{ ...repo('runtime:env-1'), connectionId: 'nested' }],
      worktreesByRepo: {
        [repoId]: [
          makeWorktree({ id, repoId, hostId: 'ssh:nested', runtimeOwnerEnvironmentId: 'env-1' })
        ]
      }
    })

    await load(store, 'local')

    expect(store.getState().worktreesByRepo[repoId]).toHaveLength(1)
    expect(store.getState().activeWorktreeId).toBe(id)
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({
      [getWorktreeVisitKey(id, 'ssh:nested')]: 42
    })
  })

  it('runtime owner removal also retires the SSH execution alias published by that runtime', async () => {
    const store = createTestStore()
    seedOwner(store, 'ssh:nested')
    store.setState({
      repos: [{ ...repo('runtime:env-1'), connectionId: 'nested' }],
      worktreesByRepo: {
        [repoId]: [
          makeWorktree({ id, repoId, hostId: 'ssh:nested', runtimeOwnerEnvironmentId: 'env-1' })
        ]
      },
      detectedWorktreesByRepo: {},
      restoredRuntimeHostIdByWorkspaceSessionKey: { [id]: 'runtime:env-1' }
    })

    await load(store, 'runtime')

    expect(store.getState().worktreesByRepo[repoId] ?? []).toEqual([])
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({})
    expect(store.getState().activeWorktreeId).toBeNull()
    expect(store.getState().restoredRuntimeHostIdByWorkspaceSessionKey).toEqual({})
  })

  it('preserves folder, floating and unattributed legacy sessions while dropping a deleted repo owner', async () => {
    const store = createTestStore()
    seedOwner(store, 'local')
    const folderKey = folderWorkspaceKey('folder-1')
    const folderTab = makeTab({ id: 'folder-tab', worktreeId: folderKey })
    const floatingTab = makeTab({ id: 'floating-tab', worktreeId: FLOATING_TERMINAL_WORKTREE_ID })
    const legacyId = 'unknown::/not-yet-loaded'
    store.setState({
      tabsByWorktree: { [folderKey]: [folderTab], [FLOATING_TERMINAL_WORKTREE_ID]: [floatingTab] },
      activeWorktreeId: null,
      activeWorkspaceKey: folderKey,
      lastVisitedAtByWorktreeId: {
        ...store.getState().lastVisitedAtByWorktreeId,
        [getWorktreeVisitKey(folderKey, 'local')]: 2,
        [legacyId]: 3
      }
    })

    await load(store, 'local')

    expect(store.getState().tabsByWorktree[folderKey]).toEqual([folderTab])
    expect(store.getState().tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toEqual([floatingTab])
    expect(store.getState().activeWorkspaceKey).toBe(folderKey)
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({
      [getWorktreeVisitKey(folderKey, 'local')]: 2,
      [legacyId]: 3
    })
  })

  it('flushes delayed editor text before removing the owner and keeps the exact draft recoverable', async () => {
    const store = createTestStore()
    seedOwner(store, 'local')
    const file = makeOpenFile({ id: '/work/repo/a.ts', worktreeId: id, isDirty: true })
    store.setState({ openFiles: [file], editorDrafts: { [file.id]: 'older text' } })
    const unregister = registerPendingEditorFlush(file.id, () => {
      expect(store.getState().openFiles).toContainEqual(file)
      store.getState().setEditorDraft(file.id, 'latest delayed text')
    })
    try {
      await load(store, 'local')

      const state = store.getState()
      expect(state.openFiles).toEqual([])
      expect(Object.values(state.editorBufferKept)).toEqual([
        expect.objectContaining({ draft: 'latest delayed text', viewIds: [file.id] })
      ])
    } finally {
      unregister()
    }
  })

  it('a superseded local empty result cannot clear the newer nonempty owner', async () => {
    const older = Promise.withResolvers<Repo[]>()
    localList.mockReturnValueOnce(older.promise).mockResolvedValue([repo('local')])
    const store = createTestStore()
    seedOwner(store, 'local')
    const pending = load(store, 'local')
    await load(store, 'local')
    older.resolve([])
    await pending

    expect(store.getState().worktreesByRepo[repoId]).toHaveLength(1)
    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({
      [getWorktreeVisitKey(id, 'local')]: 42
    })
  })

  it('an empty response from a tombstoned runtime cannot settle history as deleted', async () => {
    const result = Promise.withResolvers<Repo[]>()
    const started = Promise.withResolvers<void>()
    remoteList.mockImplementation(() => {
      started.resolve()
      return result.promise
    })
    const store = createTestStore()
    seedOwner(store, 'runtime:env-1', false)
    const pending = load(store, 'runtime')
    await started.promise
    store.setState({ removedRuntimeEnvironmentIds: new Set(['env-1']) })
    result.resolve([])
    await pending

    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({
      [getWorktreeVisitKey(id, 'runtime:env-1')]: 42
    })
  })

  it('replays accepted empty owner proof when saved history hydrates after the catalog', async () => {
    const store = createTestStore()
    await load(store, 'runtime')
    seedOwner(store, 'runtime:env-1', false)

    store.getState().pruneLastVisitedTimestamps()

    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({})
    expect(store.getState().restoredRuntimeHostIdByWorkspaceSessionKey).toEqual({})
    expect(store.getState().activeWorktreeId).toBeNull()
    expect(store.getState().activeWorkspaceKey).toBeNull()
  })

  it('does not replay accepted empty proof after its runtime connection was replaced', async () => {
    const store = createTestStore()
    await load(store, 'runtime')
    sshState.generation += 1
    seedOwner(store, 'runtime:env-1', false)

    store.getState().pruneLastVisitedTimestamps()

    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({
      [getWorktreeVisitKey(id, 'runtime:env-1')]: 42
    })
    expect(store.getState().activeWorktreeId).toBe(id)
    expect(store.getState().restoredRuntimeHostIdByWorkspaceSessionKey[id]).toBe('runtime:env-1')
  })

  it('a newer owner request invalidates prior empty proof before its result settles', async () => {
    const store = createTestStore()
    await load(store, 'runtime')
    const result = Promise.withResolvers<Repo[]>()
    const started = Promise.withResolvers<void>()
    remoteList.mockImplementation(() => {
      started.resolve()
      return result.promise
    })
    const pending = load(store, 'runtime')
    await started.promise
    seedOwner(store, 'runtime:env-1', false)

    store.getState().pruneLastVisitedTimestamps()

    expect(store.getState().lastVisitedAtByWorktreeId).toEqual({
      [getWorktreeVisitKey(id, 'runtime:env-1')]: 42
    })
    expect(store.getState().activeWorktreeId).toBe(id)
    result.resolve([repo('runtime:env-1')])
    await pending
    expect(store.getState().activeWorktreeId).toBe(id)
  })
})

describe('accepted catalog replay and unlisted owner preservation', () => {
  it('does not retain a placeholder repo hydrated after accepted empty proof', async () => {
    const store = createTestStore()
    await load(store, 'runtime')
    store.getState().hydrateWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        activeRepoId: repoId,
        activeWorktreeId: id,
        activeWorkspaceExecutionHostId: 'runtime:env-1',
        lastVisitedAtByWorktreeId: { [getWorktreeVisitKey(id, 'runtime:env-1')]: 42 },
        tabsByWorktree: {
          [id]: [makeTab({ id: 'persisted', worktreeId: id, ptyId: 'remote:env-1@@old' })]
        }
      },
      { runtimeHostIdByWorkspaceSessionKey: { [id]: 'runtime:env-1' } }
    )
    store.getState().pruneLastVisitedTimestamps()
    expect(store.getState().repos).toEqual([])
  })

  it('does not delete a project added after accepted empty proof', async () => {
    const store = createTestStore()
    await load(store, 'local')
    window.api.repos.add = vi.fn().mockResolvedValue({ repo: repo('local') })
    await store.getState().addRepoPath('/work/repo', 'git', { runtimeEnvironmentId: null })
    expect(store.getState().repos).toHaveLength(1)
    store.setState({
      worktreesByRepo: { [repoId]: [makeWorktree({ id, repoId, hostId: 'local' })] },
      activeWorktreeId: id,
      activeWorkspaceExecutionHostId: 'local',
      lastVisitedAtByWorktreeId: { [getWorktreeVisitKey(id, 'local')]: 50 },
      tabsByWorktree: { [id]: [makeTab({ id: 'new', worktreeId: id, ptyId: 'new-pty' })] }
    })
    store.getState().pruneLastVisitedTimestamps()
    expect(store.getState().worktreesByRepo[repoId]).toHaveLength(1)
    expect(store.getState().tabsByWorktree[id]).toHaveLength(1)
  })

  it('purges proved session-only terminal state despite no worktree row', async () => {
    const store = createTestStore()
    seedOwner(store, 'runtime:env-1', false)
    store.setState({
      tabsByWorktree: { [id]: [makeTab({ id: 'old', worktreeId: id, ptyId: 'remote:env-1@@old' })] }
    })
    await load(store, 'runtime')
    expect(store.getState().tabsByWorktree[id]).toBeUndefined()
  })
})

for (const hostId of ['runtime:env-1', 'ssh:direct'] as const) {
  it(`unhosted ${hostId} row is not locally owned`, async () => {
    const store = createTestStore()
    seedOwner(store, hostId)
    store.setState({
      worktreesByRepo: { [repoId]: [makeWorktree({ id, repoId, hostId: undefined })] },
      detectedWorktreesByRepo: {}
    })
    await load(store, 'local')
    expect(store.getState().worktreesByRepo[repoId]).toHaveLength(1)
    expect(store.getState().tabsByWorktree[id]).toHaveLength(1)
  })
}

it('nonempty runtime catalog retains its nested SSH worktree and qualified session', async () => {
  const store = createTestStore()
  seedOwner(store, 'ssh:nested')
  const ownerRepo = { ...repo('runtime:env-1'), connectionId: 'nested' }
  const row = makeWorktree({ id, repoId, hostId: 'ssh:nested', runtimeOwnerEnvironmentId: 'env-1' })
  store.setState({
    repos: [ownerRepo],
    worktreesByRepo: { [repoId]: [row] },
    detectedWorktreesByRepo: {},
    restoredRuntimeHostIdByWorkspaceSessionKey: { [id]: 'runtime:env-1' }
  })
  remoteList.mockResolvedValue([ownerRepo])
  await load(store, 'runtime')
  expect(store.getState().worktreesByRepo[repoId]).toEqual([row])
  expect(store.getState().activeWorktreeId).toBe(id)
  expect(store.getState().lastVisitedAtByWorktreeId).toEqual({
    [getWorktreeVisitKey(id, 'ssh:nested')]: 42
  })
  expect(store.getState().restoredRuntimeHostIdByWorkspaceSessionKey).toEqual({
    [id]: 'runtime:env-1'
  })
})

it('local deletion preserves unlisted direct SSH sibling PTY', async () => {
  const store = createTestStore()
  seedOwner(store, 'local', false)
  store.setState({
    repos: [{ ...repo('ssh:direct'), connectionId: 'direct' }],
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    tabsByWorktree: {
      [id]: [makeTab({ id: 'ssh-sibling', worktreeId: id, ptyId: 'ssh:direct@@shell' })]
    },
    ptyIdsByTabId: { 'ssh-sibling': ['ssh:direct@@shell'] }
  })
  await load(store, 'local')
  expect(store.getState().tabsByWorktree[id]).toEqual([
    expect.objectContaining({ id: 'ssh-sibling' })
  ])
})

for (const browserRuntimeEnvironmentId of [null, 'env-2']) {
  it(`runtime deletion preserves unlisted page-only sibling ${browserRuntimeEnvironmentId ?? 'client'}`, async () => {
    const store = createTestStore()
    seedOwner(store, 'runtime:env-1', false)
    const browser = {
      id: 'browser-sibling',
      worktreeId: id,
      url: 'https://example.test',
      title: 'Sibling',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: 1
    }
    const page = {
      ...browser,
      id: 'sibling-page',
      workspaceId: browser.id,
      browserRuntimeEnvironmentId
    }
    store.setState({
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      browserTabsByWorktree: { [id]: [browser] },
      browserPagesByWorkspace: { [browser.id]: [page] }
    })
    await load(store, 'runtime')
    expect(store.getState().browserTabsByWorktree[id]).toEqual([browser])
    expect(store.getState().browserPagesByWorkspace[browser.id]).toEqual([page])
  })
}

it('purges a removed runtime session despite an unprefixed parked reconnect hint', async () => {
  const store = createTestStore()
  seedOwner(store, 'runtime:env-1', false)
  store.setState({
    tabsByWorktree: {
      [id]: [makeTab({ id: 'runtime-tab', worktreeId: id, ptyId: 'remote:env-1@@live' })]
    },
    ptyIdsByTabId: { 'runtime-tab': ['remote:env-1@@live'] },
    pendingReconnectPtyIdByTabId: { 'runtime-tab': 'parked-native-hint' }
  })
  await load(store, 'runtime')
  expect(store.getState().tabsByWorktree[id]).toBeUndefined()
  expect(store.getState().pendingReconnectPtyIdByTabId['runtime-tab']).toBeUndefined()
})

for (const loader of ['local', 'runtime', 'all-hosts'] as const) {
  it(`${loader}: settles notifications for pane markers removed by accepted absence`, async () => {
    const store = createTestStore()
    seedOwner(store, loader === 'local' ? 'local' : 'runtime:env-1')
    const dismiss = vi.fn().mockResolvedValue(undefined)
    Object.assign(window.api, { notifications: { dismiss } })
    store.setState({ unreadTerminalPanes: { 'tab:L1': 'terminal-bell' } })
    await load(store, loader)
    expect(store.getState().unreadTerminalPanes).toEqual({})
    expect(dismiss).toHaveBeenCalledExactlyOnceWith([], ['tab:L1'])
  })
}

it('accepted proof replay settles notifications after late session hydration', async () => {
  const store = createTestStore()
  await load(store, 'local')
  seedOwner(store, 'local', false)
  const dismiss = vi.fn().mockResolvedValue(undefined)
  Object.assign(window.api, { notifications: { dismiss } })
  store.setState({
    tabsByWorktree: { [id]: [makeTab({ id: 'tab', worktreeId: id, ptyId: 'pty' })] },
    unreadTerminalPanes: { 'tab:L1': 'terminal-bell' }
  })
  store.getState().pruneLastVisitedTimestamps()
  expect(store.getState().unreadTerminalPanes).toEqual({})
  expect(dismiss).toHaveBeenCalledExactlyOnceWith([], ['tab:L1'])
})
