import type { ExecutionHostId } from '../../../shared/execution-host'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as TransportFixtureModule from '@/runtime/layout-apply-test-transport.test-fixture'
import {
  launchWorkspaceState,
  perClientLoader,
  type LaunchStoreHolder
} from '@/lib/launch-parity-renderer.test-fixture'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { getDefaultSettings } from '../../../shared/constants'
import { makeAutomation, makeRun } from '@/components/automations/automations-page-fixtures'

// Keep main’s mocked layout transport outside module resets so each rebuilt client still reaches it.
type TransportFixture = typeof TransportFixtureModule
const main = vi.hoisted((): { transport: TransportFixture['layoutApplyTestTransport'] | null } => ({
  transport: null
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const fixture = await import('@/runtime/layout-apply-test-transport.test-fixture')
  main.transport = fixture.layoutApplyTestTransport
  return fixture.runtimeRpcClientWithLayoutApply(await importOriginal())
})

const holder = vi.hoisted((): LaunchStoreHolder => ({ store: null }))
vi.mock('@/store', async () =>
  (await import('@/lib/launch-parity-renderer.test-fixture')).launchStoreModuleMock(holder)
)
// The stdin-after-start paste is pinned by launch-agent-background-session.test.ts.
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  registerEagerPtyBuffer: vi.fn(),
  subscribeToPtyExit: vi.fn(() => () => {})
}))
vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: vi.fn(() => () => {})
}))

const load = perClientLoader(async () => ({
  launch: await import('./launch-agent-background-session'),
  phone: await import('@/runtime/sync-runtime-graph/mobile-session-snapshots'),
  switch: await import('../../../shared/layout-owner-switch'),
  remoteCreate: await import('./runtime-agent-background-create'),
  remoteStream: await import('@/runtime/runtime-terminal-stream'),
  preferences:
    await import('@/runtime/agent-launch-settings/host-agent-launch-preferences-resource'),
  settingsTransport:
    await import('@/runtime/agent-launch-settings/agent-launch-settings-transport'),
  workspace: await import('@/hooks/automation-dispatch-workspace')
}))

// Pin automation pty:spawn and mobile-tab behavior as the convergence baseline before C7 replaces this producer.
describe('row 5: desktop automation pty:spawn request', () => {
  beforeAll(async () => {
    await load('darwin')
    await load('linux')
    await load('win32')
  }, 240_000)
  afterEach(() => vi.unstubAllGlobals())

  it.each([false, true])(
    'retains the selected standalone folder from preparation through launch with copied IDs (reverse=%s)',
    async (reverse) => {
      const modules = await load('darwin')
      const store = modules.createStore()
      holder.store = store
      store.setState(
        launchWorkspaceState(
          { kind: 'folder', path: '/selected/folder' },
          getDefaultSettings('/home/alice')
        )
      )
      const folder = { ...store.getState().folderWorkspaces[0]!, executionHostId: 'local' as const }
      const twin = {
        ...folder,
        executionHostId: 'ssh:other' as const,
        folderPath: '/foreign/folder'
      }
      const repo = {
        id: 'repo-1',
        path: '/selected',
        kind: 'folder' as const,
        displayName: 'Project',
        badgeColor: '#000',
        addedAt: 1
      }
      store.setState({
        folderWorkspaces: [folder],
        repos: [repo],
        activeWorktreeId: 'unrelated',
        activeWorkspaceExecutionHostId: 'ssh:other'
      })
      const automation = makeAutomation({
        workspaceMode: 'existing',
        workspaceId: `folder:${folder.id}`,
        projectId: repo.id,
        runContext: {
          kind: 'workspace-run',
          projectId: 'project',
          projectHostSetupId: 'setup',
          repoId: repo.id,
          path: repo.path,
          hostId: 'local'
        }
      })
      const run = makeRun({ trigger: 'manual' })
      const resolved = modules.workspace.resolveAutomationDispatchWorkspace(
        store.getState(),
        automation,
        run
      )
      if (!resolved.repo) {
        throw new Error('missing repo')
      }
      store.setState({ folderWorkspaces: reverse ? [twin, folder] : [folder, twin] })
      const markDispatchResult = vi.fn()
      const worktree = await modules.workspace.prepareAutomationDispatchWorkspace({
        state: store.getState(),
        automation,
        run,
        dispatchToken: 'token',
        resolved: { ...resolved, repo: resolved.repo },
        markDispatchResult
      })
      if (!worktree) {
        throw new Error('missing selected folder')
      }
      expect(worktree).toMatchObject({ path: '/selected/folder', hostId: 'local' })
      const spawn = vi.fn(async () => ({ id: 'pty-selected-folder' }))
      vi.stubGlobal('window', {
        dispatchEvent: vi.fn(),
        api: { pty: { spawn, write: vi.fn(), kill: vi.fn() }, runtime: { call: vi.fn() } }
      })
      await modules.launch.launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: worktree.id,
        resolvedTarget: { worktree, repo: resolved.repo },
        prompt: 'Selected folder task'
      })
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/selected/folder', connectionId: null })
      )
      expect(markDispatchResult).not.toHaveBeenCalled()
      store.setState({ folderWorkspaces: [twin] })
      await expect(
        modules.workspace.prepareAutomationDispatchWorkspace({
          state: store.getState(),
          automation,
          run,
          dispatchToken: 'token',
          resolved: { ...resolved, repo: resolved.repo },
          markDispatchResult
        })
      ).resolves.toBeNull()
      expect(markDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({ runId: run.id, status: 'skipped_unavailable' })
      )
      expect(spawn).toHaveBeenCalledTimes(1)
    }
  )

  it.each([false, true])(
    'keeps selected facts through actual adoption with identical local/SSH IDs (reverse=%s)',
    async (reverse) => {
      const modules = await load('win32')
      const store = modules.createStore()
      holder.store = store
      store.setState(
        launchWorkspaceState(
          {
            kind: 'repo',
            path: 'C:\\same',
            projectRuntime: { kind: 'wsl', distro: 'ProjectDistro' }
          },
          {
            ...getDefaultSettings('/home/alice'),
            localWindowsRuntimeDefault: { kind: 'wsl', distro: 'OtherDistro' },
            terminalWindowsShell: 'powershell.exe'
          }
        )
      )
      const initial = store.getState()
      const repo = initial.repos[0]!
      const worktree = initial.worktreesByRepo[repo.id]![0]!
      const twinRepo = { ...repo, executionHostId: 'ssh:other' as const, connectionId: 'other' }
      const twinWorktree = { ...worktree, hostId: 'ssh:other' as const }
      const catalog = projectHostSetupProjectionFromRepos([repo, twinRepo])
      const localProjectIds = new Set(
        catalog.setups.filter((setup) => setup.hostId === 'local').map((setup) => setup.projectId)
      )
      store.setState({
        projects: catalog.projects.map((project) => ({
          ...project,
          ...(localProjectIds.has(project.id)
            ? { localWindowsRuntimePreference: { kind: 'wsl' as const, distro: 'ProjectDistro' } }
            : {})
        })),
        projectHostSetups: catalog.setups,
        repos: reverse ? [twinRepo, repo] : [repo, twinRepo],
        worktreesByRepo: {
          [repo.id]: reverse ? [twinWorktree, worktree] : [worktree, twinWorktree]
        },
        activeWorktreeId: 'unrelated',
        activeWorkspaceExecutionHostId: 'ssh:other',
        sshConnectionStates: new Map([
          [
            'other',
            {
              targetId: 'other',
              status: 'connected',
              remotePlatform: 'linux',
              error: null,
              reconnectAttempt: 0
            }
          ]
        ])
      })
      const spawn = vi.fn(async () => ({ id: 'pty-selected' }))
      const kill = vi.fn()
      vi.stubGlobal('window', {
        dispatchEvent: vi.fn(),
        api: { pty: { spawn, write: vi.fn(), kill }, runtime: { call: vi.fn() } }
      })
      const launched = await modules.launch.launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: worktree.id,
        resolvedTarget: { repo, worktree },
        prompt: 'Selected task'
      })
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: 'C:\\same',
          connectionId: null,
          projectRuntime: expect.objectContaining({
            status: 'resolved',
            runtime: expect.objectContaining({ kind: 'wsl', distro: 'ProjectDistro' })
          })
        })
      )
      const adopted = store
        .getState()
        .unifiedTabsByWorktree[worktree.id]?.find((tab) => tab.entityId === launched?.tabId)
      expect(adopted?.executionHostId).toBe('local')
      expect(
        store.getState().tabsByWorktree[worktree.id]?.find((tab) => tab.id === launched?.tabId)
          ?.shellOverride
      ).toBe('wsl.exe')
      expect(store.getState().activeWorktreeId).toBe('unrelated')
      spawn.mockImplementationOnce(async () => {
        store.setState({ repos: [twinRepo], worktreesByRepo: { [repo.id]: [twinWorktree] } })
        return { id: 'pty-disappeared' }
      })
      expect(
        await modules.launch.launchAgentBackgroundSession({
          agent: 'claude',
          worktreeId: worktree.id,
          resolvedTarget: { repo, worktree }
        })
      ).toBeNull()
      expect(kill).toHaveBeenCalledWith('pty-disappeared')
      expect(store.getState().unifiedTabsByWorktree[worktree.id]).toHaveLength(1)
      await expect(
        modules.launch.launchAgentBackgroundSession({
          agent: 'claude',
          worktreeId: worktree.id,
          resolvedTarget: { repo, worktree }
        })
      ).rejects.toThrow()
      expect(spawn).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['ssh:other', 'runtime:server', 'folder'] as const)(
    'publishes the selected remote or registered-folder owner through the actual store (%s)',
    async (kind) => {
      const modules = await load('darwin')
      const store = modules.createStore()
      holder.store = store
      store.setState(
        launchWorkspaceState({ kind: 'repo', path: '/same' }, getDefaultSettings('/home/alice'))
      )
      const initial = store.getState()
      const baseRepo = initial.repos[0]!
      const baseWorktree = initial.worktreesByRepo[baseRepo.id]![0]!
      const hostId: ExecutionHostId = kind === 'folder' ? 'local' : kind
      const repo = {
        ...baseRepo,
        executionHostId: hostId,
        kind: kind === 'folder' ? ('folder' as const) : ('git' as const),
        connectionId: kind === 'ssh:other' ? 'other' : null
      }
      const worktree = { ...baseWorktree, hostId }
      store.setState({
        repos: [baseRepo, repo].filter((_, index) => kind !== 'folder' || index === 1),
        worktreesByRepo: { [repo.id]: kind === 'folder' ? [worktree] : [baseWorktree, worktree] },
        activeWorktreeId: 'unrelated',
        sshConnectionStates: new Map([
          [
            'other',
            {
              targetId: 'other',
              status: 'connected',
              remotePlatform: 'linux',
              error: null,
              reconnectAttempt: 0
            }
          ]
        ]),
        runtimeStatusByEnvironmentId: new Map([
          [
            'server',
            {
              checkedAt: 1,
              status: {
                runtimeId: 'server',
                rendererGraphEpoch: 0,
                graphStatus: 'ready',
                authoritativeWindowId: null,
                liveTabCount: 0,
                liveLeafCount: 0,
                hostPlatform: 'linux'
              }
            }
          ]
        ])
      })
      const remote = vi
        .fn<
          Awaited<ReturnType<typeof modules.remoteCreate.prepareRuntimeAgentBackgroundTerminal>>
        >()
        .mockResolvedValue({
          terminal: { handle: 'term_server', worktreeId: worktree.id, title: null }
        })
      const prepare = vi
        .spyOn(modules.remoteCreate, 'prepareRuntimeAgentBackgroundTerminal')
        .mockResolvedValue(remote)
      const readSettings = vi
        .spyOn(modules.settingsTransport, 'readHostAgentLaunchSettings')
        .mockResolvedValue(null)
      const supportsChoices = vi
        .spyOn(modules.settingsTransport, 'hostSupportsLaunchChoices')
        .mockResolvedValue(false)
      const stream = vi
        .spyOn(modules.remoteStream, 'subscribeToRuntimeTerminalData')
        .mockResolvedValue(() => {})
      const spawn = vi.fn(async () => ({
        id: kind === 'ssh:other' ? 'ssh:other@@pty-1' : 'pty-folder'
      }))
      vi.stubGlobal('window', {
        dispatchEvent: vi.fn(),
        api: { pty: { spawn, write: vi.fn(), kill: vi.fn() }, runtime: { call: vi.fn() } }
      })
      try {
        const launched = await modules.launch.launchAgentBackgroundSession({
          agent: 'claude',
          worktreeId: worktree.id,
          resolvedTarget: { repo, worktree }
        })
        expect(
          store
            .getState()
            .unifiedTabsByWorktree[worktree.id]?.find((tab) => tab.entityId === launched?.tabId)
            ?.executionHostId
        ).toBe(hostId)
        if (kind === 'runtime:server') {
          expect(prepare).toHaveBeenCalledWith('server')
          expect(remote).toHaveBeenCalledWith(
            expect.objectContaining({ environmentId: 'server', worktreeId: worktree.id })
          )
          expect(spawn).not.toHaveBeenCalled()
          launched?.releaseRuntimeObservers()
        } else {
          expect(spawn).toHaveBeenCalledWith(
            expect.objectContaining({
              cwd: '/same',
              connectionId: kind === 'ssh:other' ? 'other' : null
            })
          )
          expect(prepare).not.toHaveBeenCalled()
          expect(remote).not.toHaveBeenCalled()
        }
      } finally {
        modules.preferences.clearHostAgentMenuSettingsForTests()
        readSettings.mockRestore()
        supportsChoices.mockRestore()
        prepare.mockRestore()
        stream.mockRestore()
      }
    }
  )
})
