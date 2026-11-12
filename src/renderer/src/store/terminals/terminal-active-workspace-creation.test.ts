import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import { getDefaultSettings } from '../../../../shared/constants'
import { createTestStore, seedStore } from '../testing/app-store-test-fixture'

import { createStoreCascadesMockApi } from '../testing/app-store-cascade-api.test-fixture'
import {
  MIXED_FOLDER,
  MIXED_GROUP
} from '../../../../shared/folder-workspaces/folder-workspace-host-routing.test-fixture'
import { resolveWorktreeOperationRouteForHost } from '@/lib/workspace/ownership/worktree-operation-route'
import { resolveTerminalPaneOwnerContext } from '@/components/terminal-pane/host-state/terminal-pane-owner-context'

const remoteCreate = vi.hoisted(() => vi.fn(async () => ({ status: 'created' })))
vi.mock('@/runtime/hosted-terminals/creation/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: remoteCreate
}))

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

vi.mock('@/components/terminal-pane/input/focus/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreCascadesMockApi()

describe('setActiveWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  it.each([false, true])(
    'retains a selected folder through normal tab creation (%s)',
    (reverse) => {
      const originalNavigator = globalThis.navigator
      Object.defineProperty(globalThis, 'navigator', {
        value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        configurable: true
      })
      try {
        const store = createTestStore()
        const localFolder = {
          ...MIXED_FOLDER,
          folderPath: 'C:/work/notes',
          executionHostId: 'local' as const
        }
        const remoteFolder = { ...localFolder, executionHostId: 'ssh:prod' as const }
        const localRepo = {
          id: 'repo1',
          path: 'C:/work/repo',
          displayName: 'Repo',
          badgeColor: '#000',
          addedAt: 0,
          projectGroupId: MIXED_GROUP.id,
          executionHostId: 'local' as const
        }
        const remoteRepo = { ...localRepo, executionHostId: 'ssh:prod' as const }
        const worktreeId = `folder:${localFolder.id}`
        seedStore(store, {
          activeWorktreeId: worktreeId,
          activeWorkspaceExecutionHostId: 'local',
          repos: reverse ? [remoteRepo, localRepo] : [localRepo, remoteRepo],
          folderWorkspaces: reverse ? [remoteFolder, localFolder] : [localFolder, remoteFolder],
          projectGroups: [MIXED_GROUP],
          projectHostSetups: [localRepo, remoteRepo].map((repo) => ({
            id: `setup-${repo.executionHostId}`,
            projectId: 'project',
            repoId: repo.id,
            hostId: repo.executionHostId,
            path: repo.path,
            displayName: repo.displayName,
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 0,
            updatedAt: 0
          })),
          projects: [
            {
              id: 'project',
              displayName: 'Project',
              badgeColor: '#000',
              sourceRepoIds: ['repo1'],
              localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
              createdAt: 0,
              updatedAt: 0
            }
          ],
          settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'powershell.exe' }
        })
        const terminal = store.getState().createTab(worktreeId)
        const current = store.getState()
        const owner = resolveTerminalPaneOwnerContext(
          current,
          worktreeId,
          terminal.id,
          resolveWorktreeOperationRouteForHost(current, worktreeId, 'local')
        )
        expect({
          shell: terminal.shellOverride,
          stamp: current.unifiedTabsByWorktree[worktreeId][0].executionHostId,
          path: owner.worktree?.path,
          runtimeRepo: owner.projectRuntimeTarget?.repo
        }).toEqual({
          shell: 'wsl.exe',
          stamp: 'local',
          path: localFolder.folderPath,
          runtimeRepo: localRepo
        })
      } finally {
        Object.defineProperty(globalThis, 'navigator', {
          value: originalNavigator,
          configurable: true
        })
      }
    }
  )
})

describe('explicit workspace terminal creation', () => {
  it.each([true, false])(
    'uses an explicit menu owner or the active shortcut workspace (%s)',
    async (explicit) => {
      const store = createTestStore()
      const first = makeWorktree({ id: 'repo1::/path/a', repoId: 'repo1', path: '/path/a' })
      const second = makeWorktree({ id: 'repo1::/path/b', repoId: 'repo1', path: '/path/b' })
      seedStore(store, {
        worktreesByRepo: { repo1: [first, second] },
        activeWorktreeId: second.id,
        activeWorkspaceExecutionHostId: 'local'
      })
      await store
        .getState()
        .openNewTerminalTabInActiveWorkspace('menu-group', explicit ? first.id : undefined)
      const target = explicit ? first.id : second.id
      const other = explicit ? second.id : first.id
      expect(store.getState().tabsByWorktree[target]).toHaveLength(1)
      expect(store.getState().tabsByWorktree[other] ?? []).toEqual([])
    }
  )
})

it.each([undefined, 'pwsh.exe'])(
  'routes a captured host and shell despite another active host (%s)',
  async (shellOverride) => {
    remoteCreate.mockClear()
    const store = createTestStore()
    const id = 'repo1::/path/twin'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id, repoId: 'repo1', path: '/path/twin', hostId: 'local' }),
          makeWorktree({
            id,
            repoId: 'repo1',
            path: '/path/twin',
            hostId: 'runtime:peer',
            runtimeOwnerEnvironmentId: 'peer'
          })
        ]
      },
      activeWorktreeId: 'another-workspace',
      activeWorkspaceExecutionHostId: 'local'
    })
    await store
      .getState()
      .openNewTerminalTabInActiveWorkspace('menu-group', id, 'runtime:peer', shellOverride)
    expect(remoteCreate).toHaveBeenCalledWith(
      {
        worktreeId: id,
        environmentId: 'peer',
        targetGroupId: 'menu-group',
        activate: true,
        selectWorktree: true,
        ...(shellOverride === undefined ? {} : { shell: 'pwsh.exe' })
      },
      { userAct: true }
    )
    expect(store.getState().tabsByWorktree[id] ?? []).toEqual([])
    remoteCreate.mockClear()
    await store
      .getState()
      .openNewTerminalTabInActiveWorkspace('menu-group', id, 'local', shellOverride)
    expect(remoteCreate).not.toHaveBeenCalled()
    expect(store.getState().unifiedTabsByWorktree[id]?.[0]?.executionHostId).toBe('local')
    expect(store.getState().tabsByWorktree[id]?.[0]?.shellOverride).toBe(shellOverride)
  }
)

it('creates a selected SSH-folder terminal through its paired server', async () => {
  vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  remoteCreate.mockClear()
  try {
    const store = createTestStore()
    seedStore(store, {
      runtimeEnvironments: [
        {
          id: 'paired-server',
          name: 'Paired server',
          createdAt: 0,
          updatedAt: 0,
          lastUsedAt: null,
          runtimeId: null,
          preferredEndpointId: 'ws',
          endpoints: []
        }
      ],
      activeWorktreeId: 'another-workspace',
      activeWorkspaceExecutionHostId: 'local',
      folderWorkspaces: [{ ...MIXED_FOLDER, connectionId: 'box', executionHostId: 'ssh:box' }],
      projectGroups: [MIXED_GROUP]
    })
    await store
      .getState()
      .openNewTerminalTabInActiveWorkspace('folder-group', 'folder:notes-1', 'ssh:box', 'bash')
    expect(remoteCreate).toHaveBeenCalledWith(
      {
        worktreeId: 'folder:notes-1',
        environmentId: 'paired-server',
        targetGroupId: 'folder-group',
        activate: true,
        selectWorktree: true,
        shell: 'bash'
      },
      { userAct: true }
    )
    expect(store.getState().tabsByWorktree['folder:notes-1'] ?? []).toEqual([])
  } finally {
    vi.unstubAllGlobals()
  }
})
