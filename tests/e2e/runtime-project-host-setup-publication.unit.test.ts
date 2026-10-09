import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeTestStores, createSqliteTestStore } from '../../src/main/persistence-test-harness'
import { Store } from '../../src/main/persistence/loading-store/store'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { PROJECT_RUNTIME_METHODS } from '../../src/main/runtime/rpc/methods/project-runtime-rpc-methods'
import type { RpcContext } from '../../src/main/runtime/rpc/core'
import type { RuntimeNotifier } from '../../src/main/runtime/runtime-notifier-contract'
import type { ExecutionHostId } from '../../src/shared/execution-host'
import type { Repo } from '../../src/shared/repo-types'
import { WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY } from '../../src/shared/protocol-version'
import { createTestStore } from '../../src/renderer/src/store/slices/store-test-helpers'
import { registerProjectCatalogIpcBridge } from '../../src/renderer/src/hooks/ipc-events/project-catalog-ipc-bridge'

const rendererHolder = vi.hoisted(() => {
  const holder: { current?: ReturnType<typeof createTestStore> } = {}
  return holder
})

vi.mock('../../src/renderer/src/store', () => ({
  useAppStore: {
    getState: () => {
      if (!rendererHolder.current) {
        throw new Error('renderer_not_initialized')
      }
      return rendererHolder.current.getState()
    }
  }
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0',
    isPackaged: false,
    on: vi.fn(),
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

const directories: string[] = []
const unsubs: (() => void)[] = []

afterEach(async () => {
  for (const unsub of unsubs.splice(0)) {
    unsub()
  }
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  rendererHolder.current = undefined
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function fixtureRepo(hostId: ExecutionHostId = 'local', id = 'repo-local'): Repo {
  return {
    id,
    path: join(tmpdir(), `setup-project-${id}`),
    kind: 'folder',
    displayName: `Project ${hostId}`,
    badgeColor: 'blue',
    addedAt: 1,
    executionHostId: hostId,
    upstream: { owner: 'fixture', repo: 'setup' },
    gitRemoteIdentity: null
  }
}

function setupRpc(runtime: OrcaRuntimeService) {
  const create = PROJECT_RUNTIME_METHODS.find((method) => method.name === 'projectHostSetup.create')
  const update = PROJECT_RUNTIME_METHODS.find((method) => method.name === 'projectHostSetup.update')
  const remove = PROJECT_RUNTIME_METHODS.find((method) => method.name === 'projectHostSetup.delete')
  const updateProject = PROJECT_RUNTIME_METHODS.find((method) => method.name === 'project.update')
  if (!create || !update || !remove || !updateProject) {
    throw new Error('missing_project_method')
  }
  const context: RpcContext = {
    runtime,
    clientCapabilities: [WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY]
  }
  return {
    create: (args: unknown) => create.handler(create.params.parse(args), context).result,
    update: (args: unknown) => update.handler(update.params.parse(args), context).result,
    delete: (args: unknown) => remove.handler(remove.params.parse(args), context).result,
    updateProject: (args: unknown) =>
      updateProject.handler(updateProject.params.parse(args), context).project
  }
}

async function openSubscribedCatalog() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-setup-publication-'))
  directories.push(directory)
  const store = createSqliteTestStore(Store, { dataFile: join(directory, 'orca-data.json') })
  store.addRepo(fixtureRepo())
  const runtime = new OrcaRuntimeService(store)
  const renderer = createTestStore()
  rendererHolder.current = renderer
  renderer.setState({ fetchProjectGroups: async () => {}, fetchFolderWorkspaces: async () => {} })
  let reposChanged: (() => void) | undefined
  const ignoreSubscription = () => () => {}
  vi.stubGlobal('window', {
    api: {
      repos: {
        // IPC reads are copies; a Store mutation must not silently mutate the renderer snapshot.
        list: async () => structuredClone(store.getRepos()),
        onChanged: (listener: () => void) => {
          reposChanged = listener
          return () => {
            reposChanged = undefined
          }
        }
      },
      projects: {
        list: async () => structuredClone(store.getProjects()),
        listHostSetups: async () => structuredClone(store.getProjectHostSetups())
      },
      worktrees: {
        onChanged: ignoreSubscription,
        onBaseStatus: ignoreSubscription,
        onRemoteBranchConflict: ignoreSubscription
      }
    }
  })
  registerProjectCatalogIpcBridge(
    unsubs,
    { enqueue: vi.fn(), dispose: vi.fn() },
    () => false,
    vi.fn()
  )
  const desktopNotify = vi.fn(() => reposChanged?.())
  const notifier: RuntimeNotifier = {
    reposChanged: desktopNotify,
    worktreesChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  }
  runtime.setNotifier(notifier)
  const clientEvent = vi.fn()
  unsubs.push(runtime.onClientEvent(clientEvent), () => runtime.setNotifier(null))
  await renderer.getState().fetchRepos()
  return { store, renderer, desktopNotify, clientEvent, rpc: setupRpc(runtime) }
}

type SubscribedCatalog = Awaited<ReturnType<typeof openSubscribedCatalog>>

async function expectCurrentCatalog({ store, renderer }: SubscribedCatalog): Promise<void> {
  await vi.waitFor(() => {
    const state = renderer.getState()
    expect(
      state.repos.map(({ id, displayName, executionHostId }) => ({
        id,
        displayName,
        executionHostId
      }))
    ).toEqual(
      store
        .getRepos()
        .map(({ id, displayName, executionHostId }) => ({ id, displayName, executionHostId }))
    )
    expect(state.projects.map(({ id, sourceRepoIds }) => ({ id, sourceRepoIds }))).toEqual(
      store.getProjects().map(({ id, sourceRepoIds }) => ({ id, sourceRepoIds }))
    )
    expect(
      state.projectHostSetups.map(({ id, hostId, repoId, displayName, path }) => ({
        id,
        hostId,
        repoId,
        displayName,
        path
      }))
    ).toEqual(
      store.getProjectHostSetups().map(({ id, hostId, repoId, displayName, path }) => ({
        id,
        hostId,
        repoId,
        displayName,
        path
      }))
    )
  })
}

function expectAnnouncements(catalog: SubscribedCatalog, count: number): void {
  expect(catalog.desktopNotify).toHaveBeenCalledTimes(count)
  expect(catalog.clientEvent.mock.calls).toEqual(
    Array.from({ length: count }, () => [{ type: 'reposChanged' }])
  )
}

describe('runtime project setup publication to subscribed catalogs', () => {
  it('publishes independent setup create, update, and delete through the existing renderer bridge', async () => {
    const catalog = await openSubscribedCatalog()
    const project = catalog.store.getProjects()[0]!
    const created = catalog.rpc.create({
      projectId: project.id,
      hostId: 'ssh:target-a',
      displayName: 'Created setup'
    })
    expect(created.setup.repoId).toBe('')
    await expectCurrentCatalog(catalog)
    expectAnnouncements(catalog, 1)

    catalog.rpc.update({ setupId: created.setup.id, updates: { displayName: 'Updated setup' } })
    await expectCurrentCatalog(catalog)
    expect(
      catalog.renderer.getState().projectHostSetups.find((setup) => setup.id === created.setup.id)
        ?.displayName
    ).toBe('Updated setup')
    expectAnnouncements(catalog, 2)

    catalog.rpc.delete({ setupId: created.setup.id })
    await expectCurrentCatalog(catalog)
    expect(
      catalog.renderer.getState().projectHostSetups.some((setup) => setup.id === created.setup.id)
    ).toBe(false)
    expectAnnouncements(catalog, 3)

    catalog.rpc.updateProject({
      projectId: project.id,
      updates: { localWindowsRuntimePreference: { kind: 'inherit-global' } }
    })
    await expectCurrentCatalog(catalog)
    expectAnnouncements(catalog, 4)
  })

  it('publishes host-scoped mutations while preserving the surviving SSH project sibling', async () => {
    const catalog = await openSubscribedCatalog()
    catalog.store.addRepo(fixtureRepo('ssh:target-a', 'repo-remote'))
    await catalog.renderer.getState().fetchRepos()
    const setup = catalog.store
      .getProjectHostSetups()
      .find((entry) => entry.hostId === 'ssh:target-a')!
    const localSetup = catalog.store
      .getProjectHostSetups()
      .find((entry) => entry.hostId === 'local')!
    const localBefore = structuredClone(
      catalog.store.getRepos().find((repo) => repo.id === 'repo-local')
    )

    catalog.rpc.update({ setupId: setup.id, updates: { displayName: 'Remote renamed' } })
    await expectCurrentCatalog(catalog)
    expect(catalog.store.getRepos().find((repo) => repo.id === 'repo-local')).toEqual(localBefore)
    expectAnnouncements(catalog, 1)

    const remoteBeforeDelete = structuredClone(
      catalog.store.getRepos().find((repo) => repo.id === 'repo-remote')
    )
    catalog.rpc.delete({ setupId: localSetup.id })
    await expectCurrentCatalog(catalog)
    expect(catalog.renderer.getState().repos.map((repo) => repo.id)).toEqual(['repo-remote'])
    expect(catalog.store.getRepos()).toEqual([remoteBeforeDelete])
    expectAnnouncements(catalog, 2)
  })

  it('does not publish or refresh catalogs for rejected mutations', async () => {
    const catalog = await openSubscribedCatalog()
    const before = structuredClone(catalog.store.getProjectHostSetups())
    const localSetup = before[0]!
    expect(() => catalog.rpc.create({ projectId: 'missing', hostId: 'local' })).toThrow(
      'Project not found'
    )
    expect(() => catalog.rpc.create({ projectId: localSetup.projectId, hostId: 'local' })).toThrow(
      'already exists'
    )
    expect(() =>
      catalog.rpc.update({ setupId: 'missing', updates: { displayName: 'No update' } })
    ).toThrow('not found')
    expect(() =>
      catalog.rpc.update({
        setupId: localSetup.id,
        updates: { path: join(tmpdir(), 'another-path') }
      })
    ).toThrow('re-importing')
    expect(() => catalog.rpc.delete({ setupId: 'missing' })).toThrow('not found')
    await expectCurrentCatalog(catalog)
    expect(catalog.store.getProjectHostSetups()).toEqual(before)
    expectAnnouncements(catalog, 0)
  })
})
