import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import type { Repo } from '../../src/shared/repo-types'
import { closeTestStores, createStore, testState } from '../../src/main/persistence-test-harness'
import { registerProjectHostSetupHandlers } from '../../src/main/ipc/repos/project-host-setup-handlers'
import { registerProjectCatalogIpcBridge } from '../../src/renderer/src/hooks/ipc-events/project-catalog-ipc-bridge'
import { createTestStore } from '../../src/renderer/src/store/slices/store-test-helpers'
import { ProjectHostSetupUpdate } from '../../src/shared/rpc-contract/project-runtime-params'

import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { registerWorktreeCreateHandlers } from '../../src/main/ipc/worktrees/create/register-worktree-create-handlers'
import { createSenderScopedRequestCancellations } from '../../src/main/ipc/sender-scoped-request-cancellation'
import {
  resolveWorkspaceCreationTarget,
  type WorkspaceCreationTarget
} from '../../src/renderer/src/lib/project-host-workspace-target'
import { buildLocalWorktreeCreateArgs } from '../../src/renderer/src/store/slices/worktrees/create/worktree-create-payload'

import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { WORKTREE_METHODS } from '../../src/main/runtime/rpc/methods/worktree'
import { repoWithFetchedOwner } from '../../src/renderer/src/store/repos/owner-routing'
import { setupWithFetchedOwner } from '../../src/renderer/src/store/projects/project-host-routing'
import { getProjectHostSetupOwnerKey } from '../../src/renderer/src/store/projects/project-compatibility-core'
import {
  createCompatibleRuntimeStatusResponse,
  type RuntimeEnvironmentCallRequest
} from '../../src/renderer/src/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../src/renderer/src/runtime/runtime-rpc-client'
import { RuntimeProjectHostSetupController } from '../../src/main/runtime/runtime-project-host-setup-controller'
import { registerDetectedWorktreeHandlers } from '../../src/main/ipc/worktrees/listing/register-detected-worktree-handlers'
import { gitExecFileAsync } from '../../src/main/git/runner'
import { isDetectedWorktreeListResult } from '../../src/renderer/src/store/slices/worktrees/listing/detected-worktree-provider-request'

const { ipcHandlers, rendererGetState, dispatchRepoChanged, registerRemoteRepo } = vi.hoisted(
  () => ({
    ipcHandlers: new Map<string, (event: unknown, args: unknown) => unknown>(),
    rendererGetState: vi.fn(),
    dispatchRepoChanged: vi.fn(),
    registerRemoteRepo: vi.fn()
  })
)
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  ipcMain: {
    handle: (name: string, handler: (event: unknown, args: unknown) => unknown) =>
      ipcHandlers.set(name, handler)
  },
  BrowserWindow: class {
    isDestroyed() {
      return false
    }
    webContents = {
      send: (channel: string) => {
        if (channel === 'repos:changed') {
          dispatchRepoChanged()
        }
      }
    }
  },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../src/main/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../src/main/telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
vi.mock('../../src/main/ipc/folder-repo-git-upgrade-wake', () => ({
  wakeFolderRepoGitUpgradeWatch: vi.fn()
}))
vi.mock('../../src/main/ipc/repos/remote-repo-registration', () => ({
  addRemoteRepoFromPath: registerRemoteRepo
}))
vi.mock('../../src/main/ipc/worktree-base-directory-watcher', () => ({
  scheduleCurrentWorktreeBaseDirectoryWatcherSync: vi.fn()
}))
vi.mock('../../src/renderer/src/store', () => ({ useAppStore: { getState: rendererGetState } }))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-setup-authority-'))
  clearRuntimeCompatibilityCacheForTests()
  ipcHandlers.clear()
  dispatchRepoChanged.mockReset()
  registerRemoteRepo.mockReset()
})
afterEach(async () => {
  await closeTestStores()
  vi.unstubAllGlobals()
  rmSync(testState.dir, { recursive: true, force: true })
})

function makeRepo(host: 'local' | 'ssh:target-a'): Repo {
  return {
    id: 'shared-id',
    displayName: host,
    path: `/fixture/${host}`,
    kind: 'folder',
    executionHostId: host,
    badgeColor: '#000',
    addedAt: 1,
    upstream: { owner: 'fixture', repo: 'same-project' }
  }
}

function invoke(channel: string, args: unknown): unknown {
  const handler = ipcHandlers.get(channel)
  if (!handler) {
    throw new Error(`Missing IPC handler: ${channel}`)
  }
  return handler(null, args)
}

function createSelectedWorkspace(
  renderer: ReturnType<typeof createTestStore>,
  target: WorkspaceCreationTarget
) {
  return renderer
    .getState()
    .createWorktree(
      target.repoId,
      'selected',
      undefined,
      'inherit',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        executionHostId: target.hostId,
        authoritativeExecutionHostId: target.setup.authoritativeExecutionHostId
      }
    )
}

describe('host-qualified setup publication to the full renderer catalog', () => {
  it.each(['git', 'folder'] as const)(
    'fences a queued actual %s listing after a successful kind change',
    async (kind) => {
      const path = join(testState.dir, 'native-repo')
      await gitExecFileAsync(['init', '--quiet', path], { cwd: testState.dir })
      await gitExecFileAsync(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: path })
      await gitExecFileAsync(
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          'commit',
          '--allow-empty',
          '-qm',
          'fixture'
        ],
        { cwd: path }
      )
      const store = createStore()
      store.addRepo({ ...makeRepo('local'), path, kind })
      const renderer = createTestStore()
      rendererGetState.mockImplementation(renderer.getState)
      let releaseOld: (() => void) | undefined
      const paused = new Promise<void>((resolve) => {
        releaseOld = resolve
      })
      let oldReadCompleted = false
      let freshReply: unknown
      const listDetected = vi.fn(async (args: unknown) => {
        const reply = await invoke('worktrees:listDetected', args)
        if (!oldReadCompleted) {
          oldReadCompleted = true
          await paused
        } else {
          freshReply = reply
        }
        return reply
      })
      vi.stubGlobal('window', {
        api: {
          repos: {
            list: async () => structuredClone(store.getRepos()),
            onChanged: (callback: () => void) => {
              dispatchRepoChanged.mockImplementation(callback)
              return () => {}
            }
          },
          projects: {
            list: async () => structuredClone(store.getProjects()),
            listHostSetups: async () => structuredClone(store.getProjectHostSetups())
          },
          projectGroups: { list: async () => [] },
          folderWorkspaces: { list: async () => [] },
          worktrees: {
            listDetected,
            onChanged: () => () => {},
            onBaseStatus: () => () => {},
            onRemoteBranchConflict: () => () => {}
          }
        }
      })
      renderer.setState({
        fetchProjectGroups: async () => {},
        fetchFolderWorkspaces: async () => {}
      })
      const unsubs: (() => void)[] = []
      registerProjectCatalogIpcBridge(
        unsubs,
        { enqueue: () => {}, dispose: () => {} },
        () => false,
        () => {}
      )
      registerProjectHostSetupHandlers(new BrowserWindow({ show: false }), store)
      registerDetectedWorktreeHandlers({
        store,
        runtime: new OrcaRuntimeService(store),
        mainWindow: new BrowserWindow({ show: false }),
        detectedWorktreeCancellations: createSenderScopedRequestCancellations(),
        worktreeRemovalsInFlight: new Map()
      })
      await renderer.getState().fetchRepos()
      const capturedRepos = renderer.getState().repos
      const options = {
        executionHostId: 'local',
        presentationOnly: true,
        requireAuthoritative: true,
        suppressRemoteLineageRefresh: true
      } as const
      const oldRequest = renderer.getState().fetchWorktrees('shared-id', options)
      let newRequest: Promise<boolean> | undefined
      try {
        await vi.waitFor(() => expect(oldReadCompleted).toBe(true))
        const nextKind = kind === 'git' ? 'folder' : 'git'
        invoke(
          'projectHostSetups:update',
          ProjectHostSetupUpdate.parse({
            setupId: 'shared-id',
            executionHostId: 'local',
            updates: { kind: nextKind }
          })
        )
        expect(store.getRepos()[0].kind).toBe(nextKind)
        await vi.waitFor(() => expect(renderer.getState().repos[0]?.kind).toBe(nextKind))
        expect(renderer.getState().repos).not.toBe(capturedRepos)
        newRequest = renderer.getState().fetchWorktrees('shared-id', options)
        await vi.waitFor(() => expect(listDetected).toHaveBeenCalledTimes(2))
        await expect(newRequest).resolves.toBe(true)
        if (
          !freshReply ||
          typeof freshReply !== 'object' ||
          !('result' in freshReply) ||
          !isDetectedWorktreeListResult(freshReply.result)
        ) {
          throw new Error('Missing current registered listing')
        }
        const admitted = renderer.getState().worktreesByRepo['shared-id']
        expect(admitted?.map((row) => row.id)).toEqual(
          freshReply.result.worktrees.filter((row) => row.visible).map((row) => row.id)
        )
        releaseOld?.()
        await expect(oldRequest).resolves.toBe(false)
        expect(renderer.getState().worktreesByRepo['shared-id']).toBe(admitted)
      } finally {
        releaseOld?.()
        await Promise.allSettled([oldRequest, ...(newRequest ? [newRequest] : [])])
        unsubs.forEach((unsubscribe) => unsubscribe())
      }
    }
  )
  it.each([
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [true, true, false],
    [false, false, true],
    [true, false, true],
    [false, true, true],
    [true, true, true]
  ])(
    'links the returned repo owner (SSH first: %s, already linked: %s, IPC: %s)',
    async (sshFirst, linked, ipc) => {
      const store = createStore()
      const local = makeRepo('local')
      const remote = makeRepo('ssh:target-a')
      if (!linked) {
        delete remote.upstream
      }
      for (const repo of sshFirst ? [remote, local] : [local, remote]) {
        store.addRepo(repo)
      }
      const beforeRepos = store.getRepos()
      const project = store.getProjects().find((row) => row.id === 'github:fixture/same-project')
      if (!project) {
        throw new Error('Missing selected project')
      }
      const controller = new RuntimeProjectHostSetupController({
        getStore: () => store,
        listRepos: () => store.getRepos(),
        addRepo: async () => local,
        addRemoteRepo: async () => remote,
        cloneRepo: async () => local,
        invalidateResolvedWorktrees: vi.fn(),
        invalidateWorktreeScan: vi.fn(),
        notifyReposChanged: vi.fn()
      })
      const args = {
        projectId: project.id,
        hostId: 'ssh:target-a' as const,
        path: remote.path,
        kind: 'folder' as const
      }
      registerRemoteRepo.mockResolvedValue({ repo: remote, alreadyExisted: false })
      registerProjectHostSetupHandlers(new BrowserWindow({ show: false }), store)
      const rawResult = await (ipc
        ? invoke('projectHostSetups:setupExistingFolder', args)
        : controller.setupExistingFolder(args))
      if (
        !rawResult ||
        typeof rawResult !== 'object' ||
        !('repo' in rawResult) ||
        !('setup' in rawResult)
      ) {
        throw new Error('Missing setup result')
      }
      const result = { repo: rawResult.repo, setup: rawResult.setup }
      if (
        !result.repo ||
        typeof result.repo !== 'object' ||
        !('executionHostId' in result.repo) ||
        !result.setup ||
        typeof result.setup !== 'object' ||
        !('hostId' in result.setup) ||
        !('id' in result.setup)
      ) {
        throw new Error('Missing setup owner')
      }
      expect(result.repo.executionHostId).toBe('ssh:target-a')
      expect(result.setup.hostId).toBe('ssh:target-a')
      expect(result.setup.id).toBe('shared-id')
      expect(store.getRepos().find((repo) => repo.executionHostId === 'local')).toEqual(
        beforeRepos.find((repo) => repo.executionHostId === 'local')
      )
      expect(
        store.getRepos().find((repo) => repo.executionHostId === 'ssh:target-a')
      ).toMatchObject({
        upstream: local.upstream,
        projectHostSetupMethod: 'imported-existing-folder'
      })
    }
  )

  it.each([
    ['folder', false],
    ['clone', false],
    ['folder', true],
    ['clone', true]
  ] as const)(
    'rolls back only a new owner when linking %s fails beside the same ID (existing: %s)',
    async (method, existed) => {
      const store = createStore()
      const existing = makeRepo(method === 'folder' ? 'local' : 'ssh:target-a')
      const created = makeRepo(method === 'folder' ? 'ssh:target-a' : 'local')
      store.addRepo(existing)
      if (existed) {
        store.addRepo(created)
      }
      const beforeRepos = store.getRepos()
      const register = async () => {
        if (!existed) {
          store.addRepo(created)
        }
        return created
      }
      const controller = new RuntimeProjectHostSetupController({
        getStore: () => store,
        listRepos: () => store.getRepos(),
        addRepo: register,
        addRemoteRepo: register,
        cloneRepo: register,
        invalidateResolvedWorktrees: vi.fn(),
        invalidateWorktreeScan: vi.fn(),
        notifyReposChanged: vi.fn()
      })
      await expect(
        method === 'folder'
          ? controller.setupExistingFolder({
              projectId: 'missing-project',
              hostId: 'ssh:target-a',
              path: created.path,
              kind: 'folder'
            })
          : controller.setupClone({
              projectId: 'missing-project',
              hostId: 'local',
              url: 'https://example.com/repo.git',
              destination: created.path
            })
      ).rejects.toThrow(/does not match/)
      expect(store.getRepos()).toEqual(beforeRepos)
    }
  )

  it('creates a folder workspace on the saved SSH setup rather than its same-ID local sibling', async () => {
    const store = createStore()
    store.addRepo(makeRepo('local'))
    store.addRepo(makeRepo('ssh:target-a'))
    const selected = resolveWorkspaceCreationTarget({
      eligibleRepos: store.getRepos(),
      projects: store.getProjects(),
      projectHostSetups: store.getProjectHostSetups(),
      projectHostSetupId: 'shared-id',
      hostId: 'ssh:target-a'
    })
    expect(selected.status).toBe('ready')
    if (selected.status !== 'ready') {
      throw new Error('Missing selected setup')
    }
    const runtime = new OrcaRuntimeService(store)
    registerWorktreeCreateHandlers({
      store,
      runtime,
      mainWindow: new BrowserWindow({ show: false }),
      detectedWorktreeCancellations: createSenderScopedRequestCancellations(),
      worktreeRemovalsInFlight: new Map()
    })
    const result = await invoke(
      'worktrees:create',
      buildLocalWorktreeCreateArgs(
        {
          repoId: selected.target.repoId,
          name: 'selected',
          options: { executionHostId: selected.target.hostId }
        },
        { name: 'selected' }
      )
    )
    expect(result).toMatchObject({
      worktree: {
        path: '/fixture/ssh:target-a',
        hostId: 'ssh:target-a',
        projectHostSetupId: 'shared-id'
      }
    })
  })

  it('routes a locally published legacy self stamp through IPC without rewriting its exact owner', async () => {
    const store = createStore()
    store.addRepo({ ...makeRepo('local'), executionHostId: 'runtime:legacy' })
    const repos = store.getRepos().map((repo) => repoWithFetchedOwner(repo, { kind: 'local' }))
    const setups = store
      .getProjectHostSetups()
      .map((setup) => setupWithFetchedOwner(setup, { kind: 'local' }))
    const selected = resolveWorkspaceCreationTarget({
      eligibleRepos: repos,
      projects: store.getProjects(),
      projectHostSetups: setups,
      projectHostSetupId: 'shared-id',
      hostId: 'runtime:legacy'
    })
    if (selected.status !== 'ready') {
      throw new Error('Missing legacy setup')
    }
    registerWorktreeCreateHandlers({
      store,
      runtime: new OrcaRuntimeService(store),
      mainWindow: new BrowserWindow({ show: false }),
      detectedWorktreeCancellations: createSenderScopedRequestCancellations(),
      worktreeRemovalsInFlight: new Map()
    })
    const create = vi.fn(async (args: unknown) => invoke('worktrees:create', args))
    const remote = vi.fn()
    vi.stubGlobal('window', {
      api: { worktrees: { create }, runtimeEnvironments: { call: remote } }
    })
    const renderer = createTestStore()
    renderer.setState({ repos, projectHostSetups: setups })
    await expect(createSelectedWorkspace(renderer, selected.target)).resolves.toMatchObject({
      worktree: { path: '/fixture/local', hostId: 'runtime:legacy' }
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ executionHostId: 'runtime:legacy' })
    )
    expect(remote).not.toHaveBeenCalled()
  })

  it.each([
    { oldPeer: false, sshFirst: false },
    { oldPeer: false, sshFirst: true },
    { oldPeer: true, sshFirst: false },
    { oldPeer: true, sshFirst: true }
  ])(
    'creates on the captured private SSH row through the dispatcher (old peer: $oldPeer, B first: $sshFirst)',
    async ({ oldPeer, sshFirst }) => {
      const store = createStore()
      for (const suffix of sshFirst ? ['b', 'a'] : ['a', 'b']) {
        store.addRepo({
          ...makeRepo('ssh:target-a'),
          executionHostId: `ssh:private-${suffix}`,
          path: `/receiver/${suffix}`
        })
      }
      const target = { kind: 'environment', environmentId: 'paired' } as const
      const repos = store.getRepos().map((repo) => repoWithFetchedOwner(repo, target))
      const setups = store
        .getProjectHostSetups()
        .map((setup) => setupWithFetchedOwner(setup, target))
      const selectedSetup = setups.find(
        (setup) => setup.authoritativeExecutionHostId === 'ssh:private-b'
      )
      if (!selectedSetup) {
        throw new Error('Missing private setup B')
      }
      const selected = resolveWorkspaceCreationTarget({
        eligibleRepos: repos,
        projectHostSetups: setups,
        projects: store.getProjects(),
        projectHostSetupId: getProjectHostSetupOwnerKey(selectedSetup)
      })
      if (selected.status !== 'ready') {
        throw new Error('Selected private setup was lost')
      }
      const runtime = new OrcaRuntimeService(store)
      const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
      const mutation = vi.fn()
      vi.stubGlobal('window', {
        api: {
          runtimeEnvironments: {
            call: async (args: RuntimeEnvironmentCallRequest) => {
              if (args.method === 'status.get') {
                const response = createCompatibleRuntimeStatusResponse()
                if (!response.ok) {
                  throw new Error('Compatibility fixture failed')
                }
                if (oldPeer) {
                  response.result.capabilities = response.result.capabilities?.filter(
                    (cap) => cap !== 'worktree.create.execution-host.v1'
                  )
                }
                return response
              }
              mutation(args)
              return dispatcher.dispatch({
                id: 'create',
                authToken: 'test',
                method: args.method,
                params: args.params
              })
            }
          }
        }
      })
      const renderer = createTestStore()
      renderer.setState({ repos, projectHostSetups: setups })
      renderer.getState().setNewWorkspaceDraft({
        repoId: selected.target.repoId,
        projectId: selected.target.projectId,
        hostId: selected.target.hostId,
        projectHostSetupId: selected.target.projectHostSetupId,
        authoritativeExecutionHostId: selected.target.setup.authoritativeExecutionHostId,
        name: 'draft',
        prompt: '',
        note: '',
        attachments: [],
        linkedWorkItem: null,
        agent: 'claude',
        linkedIssue: '',
        linkedPR: null,
        linkedGitLabIssue: null,
        linkedGitLabMR: null,
        baseBranch: ''
      })
      const draft = structuredClone(renderer.getState().newWorkspaceDraft)
      expect(draft?.projectHostSetupId).toBe('shared-id')
      const restored = resolveWorkspaceCreationTarget({
        eligibleRepos: repos,
        projectHostSetups: setups,
        projects: store.getProjects(),
        projectHostSetupId: draft?.projectHostSetupId,
        hostId: draft?.hostId,
        authoritativeExecutionHostId: draft?.authoritativeExecutionHostId
      })
      if (restored.status !== 'ready') {
        throw new Error('Selected private setup was lost after draft restore')
      }
      expect(restored.target.setup.authoritativeExecutionHostId).toBe('ssh:private-b')
      const creation = createSelectedWorkspace(renderer, restored.target)
      if (oldPeer) {
        await expect(creation).rejects.toThrow(/Update Orca/)
        expect(mutation).not.toHaveBeenCalled()
        expect(store.getFolderWorkspaces()).toEqual([])
      } else {
        await expect(creation).resolves.toMatchObject({
          worktree: {
            path: '/receiver/b',
            hostId: 'ssh:private-b',
            projectHostSetupId: 'shared-id'
          }
        })
        expect(mutation).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'worktree.create',
            params: expect.objectContaining({ executionHostId: 'ssh:private-b' })
          })
        )
        expect(renderer.getState().worktreesByRepo['shared-id']).toEqual([
          expect.objectContaining({ path: '/receiver/b', hostId: 'ssh:private-b' })
        ])
      }
    }
  )

  it.each([false, true])(
    'keeps sibling rows through update/delete (SSH first: %s)',
    async (sshFirst) => {
      const store = createStore()
      for (const host of sshFirst
        ? (['ssh:target-a', 'local'] as const)
        : (['local', 'ssh:target-a'] as const)) {
        store.addRepo(makeRepo(host))
      }
      const renderer = createTestStore()
      rendererGetState.mockImplementation(renderer.getState)
      vi.stubGlobal('window', {
        api: {
          repos: {
            list: async () => structuredClone(store.getRepos()),
            onChanged: (callback: () => void) => {
              dispatchRepoChanged.mockImplementation(callback)
              return () => {}
            }
          },
          projects: {
            list: async () => structuredClone(store.getProjects()),
            listHostSetups: async () => structuredClone(store.getProjectHostSetups()),
            deleteHostSetup: async (args: unknown) => invoke('projectHostSetups:delete', args)
          },
          projectGroups: { list: async () => [] },
          folderWorkspaces: { list: async () => [] },
          worktrees: {
            onChanged: () => () => {},
            onBaseStatus: () => () => {},
            onRemoteBranchConflict: () => () => {}
          }
        }
      })
      // Other catalogs are unrelated to the setup publication being exercised.
      renderer.setState({
        fetchProjectGroups: async () => {},
        fetchFolderWorkspaces: async () => {}
      })
      const unsubs: (() => void)[] = []
      registerProjectCatalogIpcBridge(
        unsubs,
        { enqueue: () => {}, dispose: () => {} },
        () => false,
        () => {}
      )
      registerProjectHostSetupHandlers(new BrowserWindow({ show: false }), store)
      await renderer.getState().fetchRepos()
      const assertSnapshot = () => {
        expect(
          renderer
            .getState()
            .repos.map((repo) => [
              repo.id,
              repo.displayName,
              repo.executionHostId,
              repo.path,
              repo.addedAt
            ])
        ).toEqual(
          store
            .getRepos()
            .map((repo) => [
              repo.id,
              repo.displayName,
              repo.executionHostId,
              repo.path,
              repo.addedAt
            ])
        )
        expect(
          renderer
            .getState()
            .projectHostSetups.map((setup) => [
              setup.id,
              setup.hostId,
              setup.repoId,
              setup.displayName
            ])
        ).toEqual(
          store
            .getProjectHostSetups()
            .map((setup) => [setup.id, setup.hostId, setup.repoId, setup.displayName])
        )
        expect(
          renderer.getState().projects.map((project) => [project.id, project.sourceRepoIds])
        ).toEqual(store.getProjects().map((project) => [project.id, project.sourceRepoIds]))
      }
      assertSnapshot()
      expect(() => invoke('projectHostSetups:delete', { setupId: 'shared-id' })).toThrow(
        /ambiguous/
      )
      expect(() =>
        invoke('projectHostSetups:delete', { setupId: 'shared-id', executionHostId: 'invalid' })
      ).toThrow()
      expect(dispatchRepoChanged).not.toHaveBeenCalled()
      invoke(
        'projectHostSetups:update',
        ProjectHostSetupUpdate.parse({
          setupId: 'shared-id',
          executionHostId: 'ssh:target-a',
          updates: { displayName: 'Selected SSH' }
        })
      )
      await vi.waitFor(assertSnapshot)
      expect(store.getRepos().find((repo) => repo.executionHostId === 'local')?.displayName).toBe(
        'local'
      )
      const selectedSetup = renderer
        .getState()
        .projectHostSetups.find((setup) => setup.hostId === 'ssh:target-a')
      if (!selectedSetup) {
        throw new Error('Missing SSH setup')
      }
      expect(
        await renderer
          .getState()
          .deleteProjectHostSetup({ setupId: selectedSetup.id, owner: selectedSetup })
      ).not.toBeNull()
      await vi.waitFor(assertSnapshot)
      expect(store.getRepos().map((repo) => repo.executionHostId)).toEqual(['local'])
      expect(store.getProjectHostSetups()[0].id).toBe('shared-id')
      invoke('projectHostSetups:delete', { setupId: 'shared-id', executionHostId: 'local' })
      await vi.waitFor(assertSnapshot)
      expect(renderer.getState().projects).toEqual([])
      for (const unsubscribe of unsubs) {
        unsubscribe()
      }
    }
  )
})
