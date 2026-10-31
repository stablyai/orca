// @vitest-environment happy-dom

import type { ResolvedWorktree } from '../../../../main/runtime/runtime-worktree-path-identity'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, render, fireEvent, screen } from '@testing-library/react'
import { useAppStore } from '../../store'
import { registerUIHandlers } from '../../../../main/ipc/ui'
import { hydratePersistedUIAfterStartupRead } from '../../lib/startup-ui-hydration'
import {
  listPendingRuntimeRepoRemovals,
  resetPendingRuntimeRepoRemovalsForTests,
  withoutPendingRuntimeRepoRemovals
} from './pending-runtime-repo-removals'
import {
  observeRuntimeHostStatusForPendingRemovals,
  resetPendingRuntimeRepoRemovalReplayForTests
} from './pending-runtime-repo-removal-replay'

import '../../../../main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import * as compatibilityPreparation from '../../../../main/persistence/tracking-repos/project-host-compatibility'
import * as workspacePruning from '../../../../main/persistence/tracking-repos/repo-worktree-pruning'
import { Store } from '../../../../main/persistence/loading-store/store'
import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedState,
  writePersistedStateJson,
  testState
} from '../../../../main/persistence/persistence-test-harness'
import { getDefaultPersistedState, getDefaultSettings } from '../../../../shared/constants'
import type { Repo } from '../../../../shared/repo-types'
import {
  adoptEndpointRepo,
  adoptEndpointProjectCatalog
} from '../../../../shared/endpoint-catalog-adoption'
import { getProjectRepoFilterHost } from '../../../../shared/project-repo-filter-selection'
import { OrcaRuntimeService } from '../../../../main/runtime/orca-runtime'

import * as persistedGroupingResidue from '../../../../main/persistence/loading-store/repo-lifecycle-ui-residue'
import * as rendererGroupingResidue from './project-grouping-preferences'
import * as projectProjection from '../../../../shared/project-host-setup-projection'
import { RpcDispatcher } from '../../../../main/runtime/rpc/dispatcher'
import { REPO_METHODS } from '../../../../main/runtime/rpc/methods/repo'
import { registerRepoCatalogHandlers } from '../../../../main/ipc/repos/repo-catalog-handlers'
import {
  buildSettingsProjectList,
  removeSettingsProjectFromAllHosts
} from '../../components/settings/settings-project-list'
import {
  prepareSettingsProjectRemoval,
  RepositoryRemoveProjectButton
} from '../../components/settings/repository/RepositoryRemoveProjectButton'
import { TooltipProvider } from '../../components/ui/tooltip'
import { removeCurrentSettingsProject } from '../../components/settings/use-settings-store-model'
import { getProjectGroupingModelFromState } from '../project-host-setup-selector'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import {
  type RuntimeEnvironmentCallRequest,
  createCompatibleRuntimeStatusResponseIfNeeded
} from '../../runtime/runtime-compatibility-test-fixture'
import { toast } from 'sonner'

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => ipc.handlers.set(name, fn),
    on: () => {},
    removeAllListeners: () => {}
  },
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
    isDestroyed() {
      return false
    }
    webContents = {
      send() {},
      isDestroyed() {
        return false
      }
    }
  },
  webContents: { getAllWebContents: () => [] }
}))
vi.mock('../../../../main/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../main/claude/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ reconcile: async () => {} })
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
const directories: string[] = []
afterEach(async () => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
  resetPendingRuntimeRepoRemovalsForTests()
  resetPendingRuntimeRepoRemovalReplayForTests()
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  Object.defineProperty(
    window,
    'api',
    originalApiDescriptor ?? { configurable: true, value: undefined }
  )
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  clearRuntimeCompatibilityCacheForTests()
})

async function addressRemovalFixture(
  registered?: Repo[],
  createRuntime: (store: Store) => OrcaRuntimeService = (store) => new OrcaRuntimeService(store)
) {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-r-address-'))
  process.stdout.write(`R fixture directory ${testState.dir}\n`)
  directories.push(testState.dir)
  const canonical: Repo[] = registered ?? [
    {
      id: 'r',
      path: '/srv/r',
      displayName: 'Harbor X',
      badgeColor: '',
      addedAt: 0,
      connectionId: 'x',
      executionHostId: 'ssh:x',
      upstream: { owner: 'org', repo: 'harbor' }
    },
    {
      id: 'r',
      path: '/srv/r',
      displayName: 'Harbor Y',
      badgeColor: '',
      addedAt: 0,
      connectionId: 'y',
      executionHostId: 'ssh:y',
      upstream: { owner: 'org', repo: 'harbor' }
    },
    {
      id: 'q',
      path: '/srv/q',
      displayName: 'Harbor Q',
      badgeColor: '',
      addedAt: 0,
      connectionId: 'y',
      executionHostId: 'ssh:y',
      upstream: { owner: 'org', repo: 'harbor' }
    }
  ]
  const serverFile = join(testState.dir, 'server', 'orca-data.json')
  writePersistedStateJson(
    serverFile,
    JSON.stringify({ ...getDefaultPersistedState(testState.dir), repos: canonical })
  )
  const server = createSqliteTestStore(Store, { dataFile: serverFile })
  const runtime = createRuntime(server)
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: REPO_METHODS.filter((method) =>
      ['repo.rm', 'repo.show', 'repo.list', 'project.list', 'projectHostSetup.list'].includes(
        method.name
      )
    )
  })
  const projection = projectProjection.projectHostSetupProjectionFromRepos(server.getRepos())
  const adopted = adoptEndpointProjectCatalog(
    { kind: 'environment', environmentId: 'E' },
    projection.projects,
    projection.setups
  )
  const repos = server
    .getRepos()
    .map((repo) => adoptEndpointRepo({ kind: 'environment', environmentId: 'E' }, repo))
  const clientFile = join(testState.dir, 'client', 'orca-data.json')
  writePersistedStateJson(
    clientFile,
    JSON.stringify({ ...getDefaultPersistedState(testState.dir), repos })
  )
  const disk = createSqliteTestStore(Store, { dataFile: clientFile })
  registerRepoCatalogHandlers(new BrowserWindow(), disk, runtime)
  registerUIHandlers(disk)
  const client = useAppStore
  client.setState({
    repos,
    projects: adopted.projects,
    projectHostSetups: adopted.setups,
    settings: { ...getDefaultSettings('/tmp'), projectGroupingMode: 'host' }
  })
  const entries = buildSettingsProjectList(
    repos,
    getProjectGroupingModelFromState(client.getState())
  )
  const x = entries.find((entry) =>
    entry.setups.some((setup) => getProjectRepoFilterHost(setup) === 'ssh:x')
  )!
  const y = entries.find(
    (entry) => entry !== x && entry.setups.some((setup) => setup.repoId === 'r')
  )!
  const calls: string[] = []
  let beforeRemove: (() => void) | undefined
  let reachable = true
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      repos: {
        removeForHost: async (args: { repoId: string; hostId: string }) =>
          ipc.handlers.get('repos:removeForHost')!({}, args)
      },
      pty: { kill: vi.fn() },
      settings: {
        set: async (patch: Parameters<Store['updateSettings']>[0]) => disk.updateSettings(patch)
      },
      ui: {
        set: async (patch: Partial<PersistedUIState>) => ipc.handlers.get('ui:set')!({}, patch)
      },
      runtimeEnvironments: {
        list: async () => [{ id: 'E' }],
        call: async (args: RuntimeEnvironmentCallRequest) => {
          if (!reachable) {
            throw new Error(
              'Could not connect to the remote Orca runtime at ws://192.0.2.1:6768: the host did not answer'
            )
          }
          const compatible = createCompatibleRuntimeStatusResponseIfNeeded(
            args,
            runtime.getRuntimeId()
          )
          if (compatible) {
            return compatible
          }
          calls.push(`${args.method}:${String(args.params?.repo)}`)
          if (args.method === 'repo.rm') {
            const operation = beforeRemove
            beforeRemove = undefined
            operation?.()
          }
          return dispatcher.dispatch({
            id: `request-${calls.length}`,
            authToken: '',
            method: args.method,
            params: args.params
          })
        }
      }
    }
  })
  const capture = (entry = x) =>
    prepareSettingsProjectRemoval(
      client.getState(),
      repos[0],
      'project',
      entry.selectionKey,
      entry.setups
    )
  const run = async (entry = x) => {
    const displayed = capture(entry)
    let operation: Promise<void> | undefined
    let currentRead: ReturnType<typeof capture> | undefined
    let currentReads = 0
    const readCurrent = () => {
      currentReads++
      currentRead = capture(entry)
      return currentRead
    }
    const view = render(
      createElement(
        TooltipProvider,
        null,
        createElement(RepositoryRemoveProjectButton, {
          repo: repos[0],
          description: displayed.description,
          confirmationKey: displayed.signature,
          readCurrentRemoval: readCurrent,
          forceVisible: true,
          removeProject: (_id, accepted) => {
            expect(accepted).toBe(currentRead)
            operation = removeCurrentSettingsProject(entry.setups, accepted)
          }
        })
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove Project' }))
    expect(calls).toEqual([])
    expect(currentReads).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Remove Project' }))
    expect(currentReads).toBe(2)
    expect(operation).toBeDefined()
    await operation
    view.unmount()
  }
  const survivors = () => server.getRepos().map((repo) => `${repo.id}/${repo.connectionId}`)
  const persisted = () => {
    server.flush()
    disk.flush()
    const serverState = readPersistedState(serverFile)
    const clientState = readPersistedState(clientFile)
    return { server: serverState.repos, client: clientState.repos, serverState, clientState }
  }
  return {
    reachable: (value: boolean) => {
      reachable = value
    },
    clientFile,
    canonical,
    server,
    runtime,
    dispatcher,
    disk,
    client,
    repos,
    x,
    y,
    calls,
    capture,
    run,
    survivors,
    persisted,
    beforeRemove: (operation: () => void) => {
      beforeRemove = operation
    }
  }
}

it('joins current Hx address disclosure to actual parser/static refusal without receiver teardown, client purge or success', async () => {
  const f = await addressRemovalFixture()
  const stop = vi.spyOn(f.runtime, 'stopTerminalsForProject')
  const remove = vi.spyOn(f.server, 'removeProjectForHost')
  expect(f.capture().description).toContain('x: /srv/r')
  expect(f.capture().description).toContain('y: /srv/r')
  expect(f.capture().description).not.toContain('/srv/q')
  await f.run()
  expect(f.calls).toEqual(['repo.show:r', 'repo.rm:r'])
  expect(stop).not.toHaveBeenCalled()
  expect(remove).not.toHaveBeenCalled()
  expect(f.survivors()).toEqual(['r/x', 'r/y', 'q/y'])
  expect(f.client.getState().repos).toHaveLength(3)
  expect(f.persisted().server).toHaveLength(3)
  expect(toast.error).toHaveBeenCalled()
  expect(toast.success).not.toHaveBeenCalled()
})

it('accepts finite Hy addresses in r,q order and keeps actual r-refusal/q-success partial', async () => {
  const f = await addressRemovalFixture()
  const accepted = f.capture(f.y)
  expect(accepted.addresses.map((setup) => setup.repoId)).toEqual(['r', 'q'])
  const mutate = vi.spyOn(f.server, 'removeProjectForHost')
  await removeSettingsProjectFromAllHosts(accepted.addresses, f.client.getState().removeProject)
  expect(f.calls).toEqual(['repo.show:r', 'repo.rm:r', 'repo.show:q', 'repo.rm:q'])
  expect(mutate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: 'q', connectionId: 'y' })
  )
  expect(f.survivors()).toEqual(['r/x', 'r/y'])
  expect(f.persisted().server).toHaveLength(2)
  expect(f.persisted().client).toHaveLength(2)
  expect(toast.success).not.toHaveBeenCalled()
})

it('removes the confirmed unique Y survivor after independent X disappearance before resolution and reloads real persisted outcomes', async () => {
  const f = await addressRemovalFixture()
  const accepted = f.capture()
  f.beforeRemove(() => f.server.removeProjectForHost(f.canonical[0]))
  await removeSettingsProjectFromAllHosts(accepted.addresses, f.client.getState().removeProject)
  expect(f.calls).toEqual(['repo.show:r', 'repo.rm:r'])
  expect(f.survivors()).toEqual(['q/y'])
  expect(f.client.getState().repos.map((repo) => repo.id)).toEqual(['q'])
  const persisted = f.persisted()
  expect(persisted.server.map((repo: Repo) => `${repo.id}/${repo.connectionId}`)).toEqual(['q/y'])
  expect(persisted.client.map((repo: Repo) => repo.id)).toEqual(['q'])
})

it('distinguishes remote absent reconciliation from an already missing client source with no dispatch', async () => {
  const f = await addressRemovalFixture()
  const accepted = f.capture()
  f.beforeRemove(() => {
    f.server.removeProjectForHost(f.canonical[0])
    f.server.removeProjectForHost(f.canonical[1])
  })
  await removeSettingsProjectFromAllHosts(accepted.addresses, f.client.getState().removeProject)
  expect(f.calls).toEqual(['repo.show:r', 'repo.rm:r'])
  expect(f.survivors()).toEqual(['q/y'])
  expect(f.client.getState().repos.map((repo) => repo.id)).toEqual(['q'])
  f.calls.length = 0
  // The original accepted address is retained, but the real owner returns unconfirmed/no dispatch.
  await removeSettingsProjectFromAllHosts(accepted.addresses, f.client.getState().removeProject)
  expect(f.calls).toEqual([])
  expect(f.persisted().server).toHaveLength(1)
})

it('retains the uniquely resolved receiver through its await and does not chase a same-address arrival or outside q', async () => {
  const f = await addressRemovalFixture()
  const accepted = f.capture()
  f.server.removeProjectForHost(f.canonical[1])
  const original = f.runtime.stopTerminalsForProject.bind(f.runtime)
  let release!: () => void
  let entered!: () => void
  const paused = new Promise<void>((resolve) => {
    entered = resolve
  })
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  let first = true
  const stops = vi
    .spyOn(f.runtime, 'stopTerminalsForProject')
    .mockImplementation(async (...args) => {
      const result = await original(...args)
      if (first) {
        first = false
        entered()
        await hold
      }
      return result
    })
  const operation = removeSettingsProjectFromAllHosts(
    accepted.addresses,
    f.client.getState().removeProject
  )
  await paused
  f.server.addRepo(f.canonical[1])
  f.server.addRepo({ ...f.canonical[2], id: 'late', path: '/srv/late' })
  release()
  await operation
  expect(stops).toHaveBeenCalledTimes(2)
  expect(stops.mock.calls.map(([repo]) => repo.connectionId)).toEqual(['x', 'x'])
  expect(f.survivors()).toEqual(['q/y', 'r/y', 'late/y'])
  expect(f.calls).toEqual(['repo.show:r', 'repo.rm:r'])
  // Broad paired residue can hide Y until refetch; it is not evidence Y was removed remotely.
  expect(f.client.getState().repos.map((repo) => repo.id)).toEqual(['q'])
  expect(f.persisted().server.map((repo: Repo) => repo.id)).toEqual(['q', 'r', 'late'])
})

it.each(['refusal', 'unique', 'absence'] as const)(
  'joins the actual offline action, saved address, startup fence and ready receiver %s settlement',
  async (outcome) => {
    const f = await addressRemovalFixture()
    f.reachable(false)
    vi.mocked(toast.error).mockClear()
    await f.run()
    expect(f.survivors()).toEqual(['r/x', 'r/y', 'q/y'])
    expect(listPendingRuntimeRepoRemovals('E')).toEqual([])
    const action = vi.mocked(toast.error).mock.calls.at(-1)?.[1]?.action
    if (!action || typeof action !== 'object' || !('onClick' in action)) {
      throw new Error('real unreachable toast must offer its action')
    }
    render(createElement('button', { onClick: action.onClick }, action.label))
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this desktop now' }))
    await vi.waitFor(() => expect(f.client.getState().repos.map((repo) => repo.id)).toEqual(['q']))
    await vi.waitFor(() => expect(f.disk.getUI().pendingRuntimeRepoRemovals).toHaveLength(1))
    f.disk.flush()
    const saved = readPersistedState(f.clientFile).ui.pendingRuntimeRepoRemovals
    expect(saved).toEqual([{ environmentId: 'E', repoId: 'r', requestedAt: expect.any(Number) }])
    expect(Object.keys(saved![0]).sort()).toEqual(['environmentId', 'repoId', 'requestedAt'])
    expect(withoutPendingRuntimeRepoRemovals(f.repos, 'runtime:E').map((repo) => repo.id)).toEqual([
      'q'
    ])
    resetPendingRuntimeRepoRemovalsForTests()
    resetPendingRuntimeRepoRemovalReplayForTests()
    if (outcome !== 'refusal') {
      f.server.removeProjectForHost(f.canonical[0])
    }
    if (outcome === 'absence') {
      f.server.removeProjectForHost(f.canonical[1])
    }
    const restarted = createSqliteTestStore(Store, { dataFile: f.clientFile })
    useAppStore.setState(f.client.getState())
    const refresh = vi.spyOn(useAppStore.getState(), 'fetchRuntimeEnvironmentRepos')
    f.reachable(true)
    // The ready edge precedes the startup seed; the production remembered-ready owner must wake it.
    observeRuntimeHostStatusForPendingRemovals({
      environmentId: 'E',
      pairingRevision: 1,
      sequence: 1,
      checkedAt: 1,
      status: null,
      verification: 'verified',
      transport: 'ready'
    })
    expect(f.calls).toEqual([])
    expect(
      hydratePersistedUIAfterStartupRead({
        persistedUI: restarted.getUI(),
        cancelled: false,
        hydratePersistedUI: useAppStore.getState().hydratePersistedUI
      })
    ).toBe(true)
    await vi.waitFor(() => expect(listPendingRuntimeRepoRemovals('E')).toEqual([]))
    await vi.waitFor(() => expect(f.disk.getUI().pendingRuntimeRepoRemovals).toEqual([]))
    expect(f.calls.filter((call) => call.startsWith('repo.rm:'))).toEqual(['repo.rm:r'])
    expect(f.survivors()).toEqual(outcome === 'refusal' ? ['r/x', 'r/y', 'q/y'] : ['q/y'])
    if (outcome === 'refusal') {
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledExactlyOnceWith('E'))
      await vi.waitFor(() => expect(f.client.getState().repos).toHaveLength(3))
      expect(toast.error).toHaveBeenCalledWith(
        'The server kept a project you removed while it was offline',
        expect.any(Object)
      )
    } else {
      expect(refresh).not.toHaveBeenCalled()
    }
    expect(toast.success).not.toHaveBeenCalled()
    f.disk.flush()
    expect(readPersistedState(f.clientFile).ui.pendingRuntimeRepoRemovals).toEqual([])
  }
)

it.each([100, 1000])(
  'charges actual finite q PR-owned grouping/residue/persistence with inherited fleet resolution scoped separately at N=%s',
  async (n) => {
    for (const q of [1, 2, n]) {
      const canonical = Array.from({ length: n }, (_, i): Repo => ({
        id: i < q ? `accepted-${i}` : `unrelated-${i}`,
        path: `/srv/${i}`,
        displayName: `Checkout ${i}`,
        badgeColor: '',
        addedAt: 0,
        executionHostId: 'ssh:x',
        connectionId: 'x',
        upstream: { owner: 'org', repo: i < q ? 'harbor' : `unrelated-${i}` }
      }))
      // Known main fleet-resolution cost is recorded separately; this is no whole-command bound.
      class ScopedFleetRuntime extends OrcaRuntimeService {
        inheritedRequests = 0
        inheritedExecutions = 0
        private observedInheritedFleet: Map<string, ResolvedWorktree> | undefined

        async observeInheritedSnapshot() {
          this.inheritedExecutions++
          this.observedInheritedFleet = await super.getResolvedWorktreeMap()
          return this.observedInheritedFleet
        }

        protected override async getResolvedWorktreeMap() {
          this.inheritedRequests++
          if (!this.observedInheritedFleet) {
            throw new Error('the actual inherited snapshot must be observed first')
          }
          return this.observedInheritedFleet
        }
      }
      const f = await addressRemovalFixture(canonical, (store) => new ScopedFleetRuntime(store))
      if (!(f.runtime instanceof ScopedFleetRuntime)) {
        throw new Error('scoped fixture runtime missing')
      }
      const runtime = f.runtime
      const projectIds = f.server.getProjects().map((project) => project.id)
      const groupingOverrides = Object.fromEntries(projectIds.map((id) => [id, 'host' as const]))
      const collapsedGroups = projectIds.map((id) => `project:${id}`)
      const filterRepoIds = canonical.map((repo) => repo.id)
      for (const store of [f.server, f.disk]) {
        store.updateSettings({ projectGroupingOverrides: groupingOverrides })
        store.updateUI({ collapsedGroups, filterRepoIds })
      }
      f.client.setState({
        settings: f.disk.getSettings(),
        collapsedGroups: new Set(collapsedGroups),
        filterRepoIds
      })
      const counts = {
        catalogCalls: 0,
        catalogRows: 0,
        catalogIdReads: 0,
        storeIdReads: 0,
        compatibility: 0,
        prune: 0,
        serverWrites: 0,
        clientWrites: 0,
        clientPublishes: 0,
        serverOtherWrites: 0,
        clientOtherWrites: 0,
        serverTotalWrites: 0,
        clientTotalWrites: 0,
        persistedGroupingCalls: 0,
        persistedGroupingIds: 0,
        rendererGroupingCalls: 0,
        filterCalls: 0,
        filterTokens: 0,
        projectionCalls: 0,
        projectionRows: 0
      }
      const persistedRetire = persistedGroupingResidue.retireRemovedProjectGroupingState
      const persistedRetireProbe = vi
        .spyOn(persistedGroupingResidue, 'retireRemovedProjectGroupingState')
        .mockImplementation((...args) => {
          persistedRetireProbe.mockClear()
          counts.persistedGroupingCalls++
          counts.persistedGroupingIds += args[1].size
          return persistedRetire(...args)
        })
      const rendererRetire = rendererGroupingResidue.retireRemovedProjectGroupingState
      const rendererRetireProbe = vi
        .spyOn(rendererGroupingResidue, 'retireRemovedProjectGroupingState')
        .mockImplementation((...args) => {
          rendererRetireProbe.mockClear()
          counts.rendererGroupingCalls++
          return rendererRetire(...args)
        })
      const filter = rendererGroupingResidue.filterRemovedProjectRepoIds
      const filterProbe = vi
        .spyOn(rendererGroupingResidue, 'filterRemovedProjectRepoIds')
        .mockImplementation((...args) => {
          filterProbe.mockClear()
          counts.filterCalls++
          counts.filterTokens += args[0].length
          return filter(...args)
        })
      const project = projectProjection.projectHostSetupProjectionFromRepos
      const projectionProbe = vi
        .spyOn(projectProjection, 'projectHostSetupProjectionFromRepos')
        .mockImplementation((...args) => {
          projectionProbe.mockClear()
          counts.projectionCalls++
          counts.projectionRows += args[0].length
          return project(...args)
        })
      const instrumented = new WeakSet<Repo>()
      const merge = compatibilityPreparation.mergeProjectHostSetupCompatibilityState
      const preparation = vi
        .spyOn(compatibilityPreparation, 'mergeProjectHostSetupCompatibilityState')
        .mockImplementation((state, repos) => {
          preparation.mockClear()
          counts.compatibility++
          for (const repo of repos) {
            if (instrumented.has(repo)) {
              continue
            }
            instrumented.add(repo)
            const id = repo.id
            Object.defineProperty(repo, 'id', {
              enumerable: true,
              configurable: true,
              get() {
                counts.storeIdReads++
                return id
              }
            })
          }
          return merge(state, repos)
        })
      const prune = vi.spyOn(workspacePruning, 'pruneWorktreeStateForRepo')
      // Seed live getters through the actual compatibility owner before measuring the first removal.
      f.server.updateRepo(canonical[0], { displayName: canonical[0].displayName })
      f.disk.updateRepo(f.repos[0], { displayName: canonical[0].displayName })
      const readCatalog = f.server.getRepos.bind(f.server)
      const catalogs = vi.spyOn(f.server, 'getRepos').mockImplementation(() => {
        const rows = readCatalog()
        // Do not retain every returned catalog in Vitest's result history during populated scans.
        catalogs.mockClear()
        counts.catalogCalls++
        counts.catalogRows += rows.length
        for (const row of rows) {
          const id = row.id
          Object.defineProperty(row, 'id', {
            enumerable: true,
            get() {
              counts.catalogIdReads++
              return id
            }
          })
        }
        return rows
      })
      const stop = vi.spyOn(f.runtime, 'stopTerminalsForProject')
      let writeScope: 'other' | 'server-repo' | 'client-repo' = 'other'
      const removeServer = f.server.removeProjectForHost.bind(f.server)
      const mutate = vi.spyOn(f.server, 'removeProjectForHost').mockImplementation((...args) => {
        const previous = writeScope
        writeScope = 'server-repo'
        try {
          return removeServer(...args)
        } finally {
          writeScope = previous
        }
      })
      const removeClient = f.disk.removeProjectForHost.bind(f.disk)
      const clientMutate = vi
        .spyOn(f.disk, 'removeProjectForHost')
        .mockImplementation((...args) => {
          const previous = writeScope
          writeScope = 'client-repo'
          try {
            return removeClient(...args)
          } finally {
            writeScope = previous
          }
        })
      const stopServerWrites = f.server.onStateWritten(() => {
        counts.serverTotalWrites++
        if (writeScope === 'server-repo') {
          counts.serverWrites++
        } else {
          counts.serverOtherWrites++
        }
      })
      const stopClientWrites = f.disk.onStateWritten(() => {
        counts.clientTotalWrites++
        if (writeScope === 'client-repo') {
          counts.clientWrites++
        } else {
          counts.clientOtherWrites++
        }
      })
      const stopPublications = f.client.subscribe(() => {
        counts.clientPublishes++
      })
      const clearCounts = () => {
        Object.assign(counts, Object.fromEntries(Object.keys(counts).map((key) => [key, 0])))
      }
      clearCounts()
      const inheritedSnapshot = await runtime.observeInheritedSnapshot()
      const inheritedProbe = {
        ...counts,
        snapshotRows: inheritedSnapshot.size,
        executions: runtime.inheritedExecutions
      }
      clearCounts()
      const accepted = f.capture()
      expect(accepted.addresses.map((setup) => setup.repoId)).toEqual(
        canonical.slice(0, q).map((repo) => repo.id)
      )
      const capturedPreparation = { ...counts }
      clearCounts()
      await removeSettingsProjectFromAllHosts(accepted.addresses, f.client.getState().removeProject)
      // Join the real Settings writer queue before readback; no mock queue or synthetic success.
      await f.client.getState().updateSettingsOrThrow({})
      counts.prune = prune.mock.calls.length
      const measured = {
        ...counts,
        receiverCalls: mutate.mock.calls.length,
        terminalSweeps: stop.mock.calls.length,
        mainFleetRequests: runtime.inheritedRequests
      }
      expect(f.calls.filter((call) => call.startsWith('repo.rm:'))).toEqual(
        canonical.slice(0, q).map((repo) => `repo.rm:${repo.id}`)
      )
      expect(measured.receiverCalls).toBe(q)
      expect(measured.terminalSweeps).toBe(2 * q)
      expect(measured.prune).toBe(2 * q)
      expect(measured.serverWrites).toBe(q)
      expect(measured.clientWrites).toBe(q)
      expect(measured.catalogRows).toBeGreaterThanOrEqual(q)
      expect(measured.compatibility).toBe(2 * q)
      expect(f.client.getState().repos.map((repo) => repo.id)).toEqual(
        canonical.slice(q).map((repo) => repo.id)
      )
      const persisted = f.persisted()
      expect(persisted.server.map((repo) => repo.id)).toEqual(
        canonical.slice(q).map((repo) => repo.id)
      )
      expect(persisted.client.map((repo) => repo.id)).toEqual(
        canonical.slice(q).map((repo) => repo.id)
      )
      const remainingProjectIds = f.server.getProjects().map((project) => project.id)
      const remainingClientProjectIds = f.client.getState().projects.map((project) => project.id)
      expect(remainingClientProjectIds).toEqual(remainingProjectIds)
      expect(f.client.getState().projectHostSetups.map((setup) => setup.repoId)).toEqual(
        canonical.slice(q).map((repo) => repo.id)
      )
      expect(f.client.getState().filterRepoIds).toEqual(canonical.slice(q).map((repo) => repo.id))
      expect([...f.client.getState().collapsedGroups]).toEqual(
        remainingProjectIds.map((id) => `project:${id}`)
      )
      expect(Object.keys(f.client.getState().settings!.projectGroupingOverrides ?? {})).toEqual(
        remainingProjectIds
      )
      for (const state of [persisted.serverState, persisted.clientState]) {
        expect(state.projects.map((project) => project.id)).toEqual(remainingProjectIds)
        expect(state.projectHostSetups.map((setup) => setup.repoId)).toEqual(
          canonical.slice(q).map((repo) => repo.id)
        )
        expect(Object.keys(state.settings.projectGroupingOverrides ?? {})).toEqual(
          remainingProjectIds
        )
        expect(state.ui.collapsedGroups).toEqual(remainingProjectIds.map((id) => `project:${id}`))
        // This fixture omits App's UI persistence subscriber; only the live filter is retired here.
        expect(state.ui.filterRepoIds).toEqual(filterRepoIds)
      }
      expect(measured.persistedGroupingCalls).toBe(2 * q)
      expect(measured.rendererGroupingCalls).toBe(q)
      expect(measured.filterCalls).toBe(q)
      expect(measured.filterTokens).toBeGreaterThanOrEqual(n)
      expect(measured.projectionCalls).toBeGreaterThan(0)
      expect(measured.serverTotalWrites).toBe(measured.serverWrites + measured.serverOtherWrites)
      expect(measured.clientTotalWrites).toBe(measured.clientWrites + measured.clientOtherWrites)
      process.stdout.write(
        `R scoped own work ${JSON.stringify({ n, q, inheritedProbe, capturedPreparation, ...measured, projectSurvivors: remainingProjectIds.length, serverSaved: persisted.server.length, clientSaved: persisted.client.length })}\n`
      )
      stopServerWrites()
      stopClientWrites()
      stopPublications()
      preparation.mockRestore()
      prune.mockRestore()
      catalogs.mockRestore()
      stop.mockRestore()
      mutate.mockRestore()
      clientMutate.mockRestore()
      persistedRetireProbe.mockRestore()
      rendererRetireProbe.mockRestore()
      filterProbe.mockRestore()
      projectionProbe.mockRestore()
    }
  },
  120000
)

it('keeps the primary singleton removal outside the grouped address closure', async () => {
  const f = await addressRemovalFixture()
  expect(f.capture(f.y).addresses.map((setup) => setup.repoId)).toEqual(['r', 'q'])
  await f.client.getState().removeProject('q', { hostId: 'runtime:E', errorFeedback: 'toast' })
  expect(f.calls).toEqual(['repo.show:q', 'repo.rm:q'])
  expect(f.survivors()).toEqual(['r/x', 'r/y'])
  expect(f.persisted().server.map((repo) => repo.id)).toEqual(['r', 'r'])
})
