import { mockPanePtyArgs } from '../../src/renderer/src/components/terminal-pane/pty-connection-test-connect-mock-pane'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as React from 'react'
import type * as WslDistroGate from '../../src/main/wsl-background-distro-gate'
import type { PtyApi } from '../../src/preload/api/pty-api'
import type { RuntimePtyController } from '../../src/main/runtime/runtime-pty-controller-contract'
import type { Project, ProjectHostSetup } from '../../src/shared/project-types'
import { getDefaultSettings, getDefaultWorkspaceSession } from '../../src/shared/constants'
import {
  MIXED_FOLDER,
  MIXED_GROUP
} from '../../src/shared/folder-workspace-host-routing.test-fixture'
import { setupPtyIpcSuite } from '../../src/main/ipc/pty/pty-ipc-test-harness'
import { registerPtyHandlers } from '../../src/main/ipc/pty/register-handlers'
import { createInitialStoreState } from '../../src/renderer/src/components/terminal-pane/pty-connection-test-store-fixtures'
import {
  createMockTransport,
  createPane,
  createManager
} from '../../src/renderer/src/components/terminal-pane/pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from '../../src/renderer/src/components/terminal-pane/pty-connection-test-deps'
import { flushAsyncTicks } from '../../src/renderer/src/components/terminal-pane/pty-connection-test-async'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../../src/renderer/src/components/terminal-pane/pty-connection-test-environment'
import type { StoreState } from '../../src/renderer/src/components/terminal-pane/pty-connection-test-store-state'
import type { AppState } from '../../src/renderer/src/store/types'
import type {
  IpcPtyTransportOptions,
  PtyTransport
} from '../../src/renderer/src/components/terminal-pane/pty-transport-types'
import { createTestStore, makeTab } from '../../src/renderer/src/store/slices/store-test-helpers'
import {
  existsSyncMock,
  wslUncDirectoryExistsAsyncMock
} from '../../src/main/ipc/pty/pty-ipc-mock-registry'
import { _setWslCachesForTests, _resetWslCachesForTests } from '../../src/main/wsl'
import {
  createSessionWriteSubscriber,
  type WorkspaceSessionWrite
} from '../../src/renderer/src/lib/session-write-subscriber'

type FixtureState = StoreState & Pick<AppState, 'projectHostSetups'>
let state: FixtureState | AppState
let mountedOptions: IpcPtyTransportOptions | undefined

vi.mock('@/store', () => ({ useAppStore: { getState: () => state, subscribe: () => () => {} } }))
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
}))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('@/components/terminal-pane/terminal-pane-recovery', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestTerminalPaneRecovery: vi.fn(async () => true)
}))
vi.mock('@/components/terminal-pane/pty-transport', () => ({
  createIpcPtyTransport: (options: IpcPtyTransportOptions) => {
    mountedOptions = options
    const transport = createMockTransport()
    const connect = vi.fn<PtyTransport['connect']>(async (connectOptions) => {
      const { spawnIpcPty } =
        await import('../../src/renderer/src/components/terminal-pane/ipc-pty-spawn-request')
      const result = await spawnIpcPty(
        options,
        connectOptions,
        typeof connectOptions.sessionId === 'string' ? connectOptions.sessionId : undefined
      )
      transport.attach({ existingPtyId: result.id, callbacks: connectOptions.callbacks })
      return result
    })
    return Object.assign(transport, { connect })
  }
}))

// This runtime-selection fixture models a running distro; stopped/unverifiable holds have their own tests.
vi.mock('../../src/main/wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof WslDistroGate>()),
  readWslDistroRunningState: vi.fn(async (): Promise<'running'> => 'running')
}))

vi.mock('electron', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.electronModuleMock())
)
vi.mock('fs', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.fsModuleMock())
)
vi.mock('node-pty', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock())
)
vi.mock('node:child_process', async (importOriginal) =>
  (await import('../../src/main/ipc/pty/pty-ipc-mock-registry')).childProcessModuleMock(
    await importOriginal()
  )
)
vi.mock('../../src/main/opencode/hook-service', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) =>
    m.openCodeHookServiceModuleMock()
  )
)
vi.mock('../../src/main/mimo/hook-service', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../src/main/agent-hooks/server', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../src/main/pi/titlebar-extension-service', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) =>
    m.piTitlebarExtensionModuleMock()
  )
)
vi.mock('../../src/main/pwsh', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.pwshModuleMock())
)
vi.mock('../../src/main/wsl', async (importOriginal) =>
  (await import('../../src/main/ipc/pty/pty-ipc-mock-registry')).wslModuleMock(
    await importOriginal()
  )
)
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('../../src/main/ipc/pty/pty-ipc-mock-registry')).fsPromisesModuleMock(
    await importOriginal()
  )
)
vi.mock('../../src/main/telemetry/client', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../src/main/telemetry/classify-error', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../src/main/cli/linux-terminal-orca-cli-shim', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../src/main/memory/pty-registry', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../src/main/agent-hooks/migration-unsupported-pty-state', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) =>
    m.migrationUnsupportedPtyModuleMock()
  )
)
vi.mock('../../src/main/codex/codex-pane-account-registry', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) =>
    m.codexPaneAccountRegistryModuleMock()
  )
)
vi.mock('../../src/main/codex/codex-state-db-backfill-recovery', () =>
  import('../../src/main/ipc/pty/pty-ipc-mock-registry').then((m) =>
    m.codexBackfillRecoveryModuleMock()
  )
)

describe('mounted folder plain-shell project runtime', () => {
  const { handlers, mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()
  const platform = process.platform

  const invokePaneSpawn: PtyApi['spawn'] = async (args) => {
    const result = await handlers.get('pty:spawn')!(null, args)
    if (
      !result ||
      typeof result !== 'object' ||
      !('id' in result) ||
      typeof result.id !== 'string'
    ) {
      throw new Error('PTY spawn did not return a terminal ID')
    }
    return { ...result, id: result.id }
  }

  beforeEach(async () => {
    mountedOptions = undefined
    const fixtureState: FixtureState = {
      ...createInitialStoreState(() => fixtureState),
      projectHostSetups: []
    }
    state = fixtureState
    await installTerminalTestGlobals()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })
  afterEach(async () => {
    _resetWslCachesForTests()
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    await restoreTerminalTestGlobals()
  })

  it.each([
    'plain',
    'plain-reversed',
    'acquired',
    'no-project',
    'planned',
    'planned-repair',
    'saved-host',
    'live',
    'live-repair'
  ] as const)('keeps the host-created folder %s runtime at registered startup', async (mode) => {
    const planned = mode === 'planned' || mode === 'planned-repair'
    const live = mode === 'live' || mode === 'live-repair'
    if (mode.endsWith('-repair')) {
      _setWslCachesForTests({ available: true, distros: ['Debian'] })
    }
    const folder = {
      ...MIXED_FOLDER,
      folderPath: 'C:/work/notes',
      executionHostId: 'local' as const
    }
    const repo = {
      id: 'repo1',
      path: 'C:/work/repo',
      projectGroupId: MIXED_GROUP.id,
      executionHostId: 'local' as const
    }
    const settings = {
      ...getDefaultSettings('/tmp'),
      terminalWindowsShell: 'wsl.exe',
      terminalWindowsWslDistro: 'Debian',
      localWindowsRuntimeDefault: { kind: 'wsl' as const, distro: 'Debian' }
    }
    const session = getDefaultWorkspaceSession()
    const worktreeId = `folder:${folder.id}`
    session.tabsByWorktree[worktreeId] = [
      makeTab({
        id: 'saved-tab',
        worktreeId,
        forceHostRuntime: mode === 'saved-host',
        startupCwd: 'C:/saved/deleted'
      })
    ]
    const getProjects = vi.fn(() => {
      if (mode === 'planned' || mode === 'live') {
        throw new Error('project temporarily unavailable')
      }
      if (mode === 'no-project') {
        return []
      }
      return [
        {
          id: 'project',
          sourceRepoIds: [repo.id],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        }
      ]
    })
    const remoteRepo = { ...repo, executionHostId: 'ssh:prod' }
    const remoteFolder = { ...folder, executionHostId: 'ssh:prod' }
    const getFolders = vi.fn(() =>
      mode === 'plain-reversed' ? [remoteFolder, folder] : [folder, remoteFolder]
    )
    const store = {
      getRepos: () => (mode === 'plain-reversed' ? [remoteRepo, repo] : [repo, remoteRepo]),
      getRepo: (id: string) => (id === repo.id ? repo : undefined),
      getProjects,
      getSettings: () => settings,
      getProjectGroups: () => [MIXED_GROUP],
      getFolderWorkspaces: getFolders,
      getWorkspaceSession: () => session
    }
    const runtime = {
      setPtyController: vi.fn<(controller: RuntimePtyController) => void>(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    const providerSpawn = installDaemonTestProvider()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the registered runtime-controller and startup store ports exercised here.
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      () => settings,
      undefined,
      store as never
    )
    const controller = runtime.setPtyController.mock.calls[0]?.[0]
    if (!controller?.spawn) {
      throw new Error('Runtime PTY controller was not registered')
    }
    existsSyncMock.mockClear()
    wslUncDirectoryExistsAsyncMock.mockClear()
    const savedSessionId = 'repo1::\\\\wsl.localhost\\Saved\\work@@abc12345'
    const leafId = '11111111-1111-4111-8111-111111111111'
    if (live) {
      session.terminalLayoutsByTabId['saved-tab'] = {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: savedSessionId }
      }
    }
    const result = await controller.spawn({
      cols: 80,
      rows: 24,
      worktreeId,
      tabId: 'saved-tab',
      ...(planned
        ? {
            launchRuntime: {
              platform: 'win32',
              pty: { shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Fedora' }
            },
            sessionId: savedSessionId
          }
        : {}),
      ...(live
        ? {
            leafId,
            preAllocatedHandle: 'handle',
            adoptedStablePane: {
              result: { id: savedSessionId, wslDistro: 'Saved' },
              owner: {
                handle: 'handle',
                tabId: 'saved-tab',
                leafId,
                ptyId: savedSessionId
              },
              materialized: true
            }
          }
        : {}),
      cwd: mode === 'acquired' ? '.' : folder.folderPath,
      ...(mode === 'acquired'
        ? {
            resolvedWorkspace: {
              id: worktreeId,
              path: 'C:/retained/notes',
              connectionId: null,
              repo: null,
              folderWorkspace: { ...folder, folderPath: 'C:/retained/notes' }
            }
          }
        : {}),
      env: live ? { ORCA_PANE_KEY: `saved-tab:${leafId}` } : {}
    })
    if (live) {
      expect(result).toMatchObject({ id: savedSessionId, wslDistro: 'Saved' })
      expect(providerSpawn).not.toHaveBeenCalled()
      expect(getProjects).not.toHaveBeenCalled()
      expect(getFolders).toHaveBeenCalledTimes(1)
      expect(existsSyncMock.mock.calls.some(([path]) => path === folder.folderPath)).toBe(false)
      expect(wslUncDirectoryExistsAsyncMock).not.toHaveBeenCalled()
      expect(session.tabsByWorktree[worktreeId][0].startupCwd).toBe('C:/saved/deleted')
      return
    }
    expect(providerSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: mode === 'acquired' ? 'C:/retained/notes' : folder.folderPath,
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: planned
          ? 'Saved'
          : mode === 'saved-host' || mode === 'no-project'
            ? 'Debian'
            : 'Ubuntu'
      })
    )
    if (planned || mode === 'saved-host') {
      expect(getProjects).not.toHaveBeenCalled()
    }
  })

  it('starts an actual forced-host tab before its session publication settles', async () => {
    const { connectPanePty } =
      await import('../../src/renderer/src/components/terminal-pane/pty-connection')
    const renderer = createTestStore()
    const folder = {
      ...MIXED_FOLDER,
      folderPath: 'C:/work/notes',
      executionHostId: 'local' as const
    }
    const repo = {
      id: 'repo1',
      path: 'C:/work/repo',
      displayName: 'Repo',
      badgeColor: '#000',
      addedAt: 0,
      projectGroupId: MIXED_GROUP.id,
      executionHostId: 'local' as const
    }
    const settings = {
      ...getDefaultSettings('/tmp'),
      terminalWindowsShell: 'powershell.exe',
      localWindowsRuntimeDefault: { kind: 'windows-host' as const }
    }
    const worktreeId = `folder:${folder.id}`
    renderer.setState({
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: 'local',
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      folderWorkspaces: [folder, { ...folder, executionHostId: 'ssh:prod' }],
      repos: [{ ...repo, executionHostId: 'ssh:prod' }, repo],
      projectGroups: [MIXED_GROUP],
      projects: [
        {
          id: 'project',
          displayName: 'Project',
          badgeColor: '#000',
          sourceRepoIds: [repo.id],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
          createdAt: 0,
          updatedAt: 0
        }
      ],
      settings
    })
    const session = getDefaultWorkspaceSession()
    let release!: () => void
    const publication = new Promise<void>((resolve) => {
      release = resolve
    })
    const persist = vi.fn(async ({ patch }: WorkspaceSessionWrite) => {
      await publication
      Object.assign(session, patch)
    })
    const dispose = createSessionWriteSubscriber({ store: renderer, persist })
    const tab = renderer
      .getState()
      .createTab(worktreeId, undefined, undefined, { forceHostRuntime: true })
    state = {
      ...renderer.getState(),
      runtimeEnvironments: [...renderer.getState().runtimeEnvironments]
    }
    const providerSpawn = installDaemonTestProvider()
    const store = {
      getRepos: () => renderer.getState().repos,
      getProjects: () => renderer.getState().projects,
      getSettings: () => settings,
      getProjectGroups: () => [MIXED_GROUP],
      getFolderWorkspaces: () => renderer.getState().folderWorkspaces,
      getWorkspaceSession: () => session,
      persistPtyBinding: vi.fn(async () => true)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the existing IPC admission, cwd and binding ports.
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      () => settings,
      undefined,
      store as never
    )
    window.api.pty.spawn = vi.fn(invokePaneSpawn)
    vi.mocked(window.api.pty.hasPty).mockResolvedValue(false)
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
    expect(session.tabsByWorktree[worktreeId]).toBeUndefined()
    const pane = createPane(1)
    const deps = buildPaneConnectionDeps(() => state, {
      worktreeId,
      tabId: tab.id,
      cwd: folder.folderPath
    })
    const binding = connectPanePty(...mockPanePtyArgs(pane, createManager(1), deps))
    try {
      await vi.waitFor(() => expect(providerSpawn).toHaveBeenCalledTimes(1))
      expect(providerSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: folder.folderPath,
          shellOverride: 'powershell.exe',
          terminalWindowsWslDistro: null
        })
      )
      expect(session.tabsByWorktree[worktreeId]).toBeUndefined()
      expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
      release()
      await vi.waitFor(() =>
        expect(session.tabsByWorktree[worktreeId]?.[0]?.forceHostRuntime).toBe(true)
      )
      await flushAsyncTicks(40)
      expect(providerSpawn).toHaveBeenCalledTimes(1)
    } finally {
      release()
      dispose()
      binding.dispose()
    }
  })

  it.each([false, true])(
    'keeps the local folder project through plain and cold startup with copied IDs (%s)',
    async (reverse) => {
      const { connectPanePty } =
        await import('../../src/renderer/src/components/terminal-pane/pty-connection')
      const localFolder = {
        ...MIXED_FOLDER,
        id: 'copied',
        folderPath: 'C:/work/notes',
        executionHostId: 'local' as const
      }
      const remoteFolder = { ...localFolder, executionHostId: 'ssh:prod' as const }
      const localRepo = {
        id: 'repo1',
        path: 'C:/work/repo',
        projectGroupId: MIXED_GROUP.id,
        executionHostId: 'local' as const
      }
      const remoteRepo = { ...localRepo, executionHostId: 'ssh:prod' as const }
      const settings = {
        ...getDefaultSettings('/tmp'),
        terminalWindowsShell: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian',
        localWindowsRuntimeDefault: { kind: 'wsl' as const, distro: 'Debian' }
      }
      const project: Project = {
        id: localRepo.id,
        displayName: 'Repo',
        badgeColor: 'blue',
        sourceRepoIds: [localRepo.id],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
        createdAt: 1,
        updatedAt: 1
      }
      const localSetup: ProjectHostSetup = {
        id: 'local-setup',
        projectId: project.id,
        hostId: 'local',
        repoId: localRepo.id,
        path: localRepo.path,
        displayName: 'Repo',
        setupState: 'ready',
        setupMethod: 'legacy-repo',
        createdAt: 1,
        updatedAt: 1
      }
      const remoteSetup: ProjectHostSetup = {
        ...localSetup,
        id: 'remote-setup',
        hostId: 'ssh:prod'
      }
      Object.assign(state, {
        activeWorktreeId: 'unrelated',
        repos: reverse ? [remoteRepo, localRepo] : [localRepo, remoteRepo],
        folderWorkspaces: reverse ? [remoteFolder, localFolder] : [localFolder, remoteFolder],
        projectGroups: [MIXED_GROUP],
        projects: [project],
        projectHostSetups: reverse ? [remoteSetup, localSetup] : [localSetup, remoteSetup],
        settings,
        unifiedTabsByWorktree: {
          'folder:copied': [
            { id: 'u', entityId: 'tab-1', contentType: 'terminal', executionHostId: 'local' }
          ]
        },
        tabsByWorktree: { 'folder:copied': [{ id: 'tab-1' }] }
      })
      const providerSpawn = installDaemonTestProvider()
      const store = {
        getRepos: () => state.repos,
        getProjectGroups: () => [MIXED_GROUP],
        getFolderWorkspaces: () =>
          reverse ? [remoteFolder, localFolder] : [localFolder, remoteFolder],
        getWorkspaceSession: getDefaultWorkspaceSession,
        persistPtyBinding: vi.fn(async () => true)
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture provides the existing admission, cwd and binding store ports exercised by this spawn.
      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        () => settings,
        undefined,
        store as never
      )
      window.api.pty.spawn = vi.fn(invokePaneSpawn)
      vi.mocked(window.api.pty.hasPty).mockResolvedValue(false)

      for (const mode of ['fresh', 'cold', 'force-host', 'no-project'] as const) {
        providerSpawn.mockClear()
        if (mode === 'force-host') {
          Object.assign(state.tabsByWorktree['folder:copied'][0], { forceHostRuntime: true })
        }
        if (mode === 'no-project') {
          Object.assign(state.tabsByWorktree['folder:copied'][0], { forceHostRuntime: false })
          state.projects = []
          state.projectHostSetups = []
          state.repos = []
        }
        const pane = createPane(1)
        const deps = buildPaneConnectionDeps(() => state, {
          worktreeId: 'folder:copied',
          cwd: 'C:/work/notes',
          ...(mode === 'cold'
            ? {
                restoredLeafId: pane.leafId,
                restoredPtyIdByLeafId: { [pane.leafId]: 'folder:copied@@deadbeef' }
              }
            : {})
        })
        const binding = connectPanePty(...mockPanePtyArgs(pane, createManager(1), deps))
        await vi.waitFor(() => expect(providerSpawn).toHaveBeenCalledTimes(1))
        await flushAsyncTicks(40)
        const expectedDistro = mode === 'fresh' || mode === 'cold' ? 'Ubuntu' : 'Debian'
        expect(providerSpawn).toHaveBeenCalledWith(
          expect.objectContaining({
            cwd: 'C:/work/notes',
            shellOverride: 'wsl.exe',
            terminalWindowsWslDistro: expectedDistro
          })
        )
        if (mode === 'cold') {
          expect(window.api.pty.spawn).toHaveBeenLastCalledWith(
            expect.objectContaining({ sessionId: 'folder:copied@@deadbeef' })
          )
        }
        expect(mountedOptions?.launchAgent).toBeUndefined()
        expect(mountedOptions?.agentLaunch).toBeUndefined()
        expect(mountedOptions?.command).toBeUndefined()
        expect(state.activeWorktreeId).toBe('unrelated')
        expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
        binding.dispose()
      }
    }
  )
})
