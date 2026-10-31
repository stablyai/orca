import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { selectWorktreeHostConnectionPhase } from '@/lib/worktree-host-connection-phase'
import { makeFolderWorkspace, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'
import { selectNativeChatWslProject, selectTerminalPaneHostState } from './terminal-pane-host-state'

const platform = vi.hoisted(() => ({ value: 'darwin' }))
vi.mock('@/lib/renderer-app-platform', () => ({ getRendererAppPlatform: () => platform.value }))
afterEach(() => {
  platform.value = 'darwin'
})

function makeState(overrides: Record<string, unknown>): AppState {
  return {
    activeWorktreeId: null,
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    removedSshTargetLabels: new Map(),
    repos: [],
    runtimeStatusByEnvironmentId: new Map(),
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    sshTargetLabels: new Map(),
    sshTargetsHydrated: true,
    worktreesByRepo: {},
    ...overrides
  } as unknown as AppState
}

describe('selectTerminalPaneHostState', () => {
  it('resolves local and direct SSH workspaces without changing reconnect semantics', () => {
    const localState = makeState({
      repos: [{ id: 'repo-local' }],
      worktreesByRepo: {
        'repo-local': [{ id: 'wt-local', repoId: 'repo-local' }]
      }
    })

    expect(selectTerminalPaneHostState(localState, 'wt-local')).toEqual({
      nativeChatIsWslProject: false,
      nativeChatTranscriptIsLocalReadable: true,
      sshReconnectEnvironmentId: null,
      sshReconnectError: null,
      sshReconnectStatus: null,
      sshReconnectTargetId: null,
      sshReconnectTargetLabel: '',
      sshReconnectTargetRemoved: false
    })

    const sshState = makeState({
      repos: [{ id: 'repo-ssh', connectionId: 'ssh-a' }],
      sshConnectionStates: new Map([
        ['ssh-a', { targetId: 'ssh-a', status: 'connected', error: null, reconnectAttempt: 0 }]
      ]),
      sshTargetLabels: new Map([['ssh-a', 'devbox']]),
      worktreesByRepo: {
        'repo-ssh': [{ id: 'wt-ssh', repoId: 'repo-ssh' }]
      }
    })

    expect(selectTerminalPaneHostState(sshState, 'wt-ssh')).toEqual({
      nativeChatIsWslProject: false,
      nativeChatTranscriptIsLocalReadable: false,
      sshReconnectEnvironmentId: null,
      sshReconnectError: null,
      sshReconnectStatus: 'connected',
      sshReconnectTargetId: 'ssh-a',
      sshReconnectTargetLabel: 'devbox',
      sshReconnectTargetRemoved: false
    })
  })

  it('recognizes WSL UNC projects on a paired Windows host', () => {
    const state = makeState({
      repos: [{ id: 'repo', executionHostId: 'runtime:windows' }],
      runtimeStatusByEnvironmentId: new Map([
        ['windows', { status: { hostPlatform: 'win32' }, checkedAt: 1 }]
      ]),
      worktreesByRepo: {
        repo: [
          {
            id: 'wt',
            repoId: 'repo',
            hostId: 'runtime:windows',
            path: '//wsl.localhost/Ubuntu/repo'
          }
        ]
      }
    })
    expect(selectTerminalPaneHostState(state, 'wt').nativeChatIsWslProject).toBe(true)
  })

  it('reads nested SSH state from the worktree owner runtime', () => {
    const state = makeState({
      repos: [
        {
          id: 'repo-runtime',
          connectionId: 'ssh-nested',
          executionHostId: 'runtime:env-a'
        }
      ],
      runtimeStatusByEnvironmentId: new Map([
        ['env-a', { status: { runtimeId: 'runtime-a' }, checkedAt: 1 }]
      ]),
      sshStateByEnvironment: new Map([
        [
          'env-a',
          {
            connectionStates: new Map([
              [
                'ssh-nested',
                {
                  targetId: 'ssh-nested',
                  status: 'disconnected',
                  error: null,
                  reconnectAttempt: 0
                }
              ]
            ]),
            targetLabels: new Map([['ssh-nested', 'build box']]),
            removedTargetLabels: new Map(),
            targetsHydrated: true
          }
        ]
      ]),
      worktreesByRepo: {
        'repo-runtime': [
          {
            id: 'wt-runtime',
            repoId: 'repo-runtime',
            hostId: 'runtime:env-a',
            runtimeOwnerEnvironmentId: 'env-a'
          }
        ]
      }
    })

    expect(selectTerminalPaneHostState(state, 'wt-runtime')).toEqual({
      nativeChatIsWslProject: null,
      nativeChatTranscriptIsLocalReadable: false,
      sshReconnectEnvironmentId: 'env-a',
      sshReconnectError: null,
      sshReconnectStatus: 'disconnected',
      sshReconnectTargetId: 'ssh-nested',
      sshReconnectTargetLabel: 'build box',
      sshReconnectTargetRemoved: false
    })
  })

  // Expose the host’s detail so terminal overlays include actionable rejection remedies.
  it('carries the failure detail alongside the status', () => {
    const state = makeState({
      repos: [{ id: 'repo-ssh', connectionId: 'ssh-a' }],
      sshConnectionStates: new Map([
        [
          'ssh-a',
          {
            targetId: 'ssh-a',
            status: 'error',
            error: 'Host key verification failed for devbox. Run: ssh-keygen -R devbox',
            reconnectAttempt: 0
          }
        ]
      ]),
      sshTargetLabels: new Map([['ssh-a', 'devbox']]),
      worktreesByRepo: { 'repo-ssh': [{ id: 'wt-ssh', repoId: 'repo-ssh' }] }
    })

    const host = selectTerminalPaneHostState(state, 'wt-ssh')

    expect(host.sshReconnectStatus).toBe('error')
    expect(host.sshReconnectError).toContain('ssh-keygen -R devbox')
  })

  it('keeps runtime-owned SSH plumbing out of reconnect UI', () => {
    const state = makeState({
      repos: [{ id: 'repo-ephemeral', connectionId: 'runtime-ssh-vm-a' }],
      worktreesByRepo: {
        'repo-ephemeral': [{ id: 'wt-ephemeral', repoId: 'repo-ephemeral' }]
      }
    })

    expect(selectTerminalPaneHostState(state, 'wt-ephemeral')).toEqual({
      nativeChatIsWslProject: false,
      nativeChatTranscriptIsLocalReadable: true,
      sshReconnectEnvironmentId: null,
      sshReconnectError: null,
      sshReconnectStatus: null,
      sshReconnectTargetId: null,
      sshReconnectTargetLabel: '',
      sshReconnectTargetRemoved: false
    })
  })

  // Keep published disconnected status during startup; shared connecting hints must not change terminal overlay/error ownership.
  it('reports the published status through the shared signal, across startup and connect', () => {
    const repos = [{ id: 'repo-ssh', connectionId: 'ssh-a' }]
    const worktreesByRepo = { 'repo-ssh': [{ id: 'wt-ssh', repoId: 'repo-ssh' }] }
    const withStatus = (status: string | null): AppState =>
      makeState({
        repos,
        worktreesByRepo,
        terminalStartupRestorationReady: false,
        sshConnectionStates: new Map(
          status ? [['ssh-a', { targetId: 'ssh-a', status, error: null, reconnectAttempt: 0 }]] : []
        )
      })

    expect(selectWorktreeHostConnectionPhase(withStatus(null), 'wt-ssh').phase).toBe('connecting')
    expect(selectTerminalPaneHostState(withStatus(null), 'wt-ssh').sshReconnectStatus).toBe(
      'disconnected'
    )
    expect(selectTerminalPaneHostState(withStatus('connecting'), 'wt-ssh').sshReconnectStatus).toBe(
      'connecting'
    )
    expect(selectTerminalPaneHostState(withStatus('connected'), 'wt-ssh').sshReconnectStatus).toBe(
      'connected'
    )
  })

  // Missing owner-runtime SSH state is unknown; show no disconnected overlay without evidence.
  it('reports no status for a nested target whose runtime has not published its SSH state', () => {
    const state = makeState({
      repos: [{ id: 'repo-runtime', connectionId: 'ssh-nested', executionHostId: 'runtime:env-a' }],
      runtimeStatusByEnvironmentId: new Map([
        ['env-a', { status: { runtimeId: 'runtime-a' }, checkedAt: 1 }]
      ]),
      sshStateByEnvironment: new Map([
        [
          'env-a',
          {
            connectionStates: new Map(),
            targetLabels: new Map(),
            removedTargetLabels: new Map(),
            targetsHydrated: false
          }
        ]
      ]),
      worktreesByRepo: {
        'repo-runtime': [
          {
            id: 'wt-runtime',
            repoId: 'repo-runtime',
            hostId: 'runtime:env-a',
            runtimeOwnerEnvironmentId: 'env-a'
          }
        ]
      }
    })

    expect(selectWorktreeHostConnectionPhase(state, 'wt-runtime').phase).toBe('unverifiable')
    expect(selectTerminalPaneHostState(state, 'wt-runtime')).toMatchObject({
      sshReconnectEnvironmentId: 'env-a',
      sshReconnectStatus: null,
      sshReconnectTargetId: 'ssh-nested'
    })
  })
})

describe('qualified native chat runtime facts', () => {
  const path = '//wsl.localhost/Ubuntu/home/me/project'
  const settings = createGlobalSettingsFixture({
    localWindowsRuntimeDefault: { kind: 'windows-host' }
  })

  it.each([0, 1, 2])('resolves a local WSL folder with %s associated repos', (count) => {
    platform.value = 'win32'
    const state = makeState({
      settings,
      projects: [],
      folderWorkspaces: [
        makeFolderWorkspace({ id: 'folder', projectGroupId: 'group', folderPath: path })
      ],
      projectGroups: [{ id: 'group' }],
      repos: Array.from({ length: count }, (_, i) => ({
        id: `repo-${i}`,
        path,
        projectGroupId: 'group'
      }))
    })
    expect(selectNativeChatWslProject(state, 'folder:folder')).toBe(true)
  })

  it.each(['windows-host', 'wsl'] as const)(
    'honors the %s default on an ordinary repo-free Windows folder',
    (kind) => {
      platform.value = 'win32'
      const state = makeState({
        projects: [],
        settings: createGlobalSettingsFixture({
          localWindowsRuntimeDefault: { kind, distro: 'Ubuntu' }
        }),
        folderWorkspaces: [
          makeFolderWorkspace({ id: 'folder', folderPath: 'C:/folder', executionHostId: 'local' })
        ]
      })
      expect(selectNativeChatWslProject(state, 'folder:folder')).toBe(kind === 'wsl')
    }
  )

  it('preserves explicit preference precedence, repair and late settings/project/path changes', () => {
    platform.value = 'win32'
    const folder = makeFolderWorkspace({ id: 'folder', projectGroupId: 'group', folderPath: path })
    const state = makeState({
      settings,
      projects: [{ id: 'repo', localWindowsRuntimePreference: { kind: 'windows-host' } }],
      folderWorkspaces: [folder],
      projectGroups: [{ id: 'group' }],
      repos: [{ id: 'repo', path, projectGroupId: 'group' }]
    })
    expect(selectNativeChatWslProject(state, 'folder:folder')).toBe(false)
    const inherit = { ...state, projects: [] }
    expect(selectNativeChatWslProject(inherit, 'folder:folder')).toBe(true)
    const ordinary = { ...inherit, folderWorkspaces: [{ ...folder, folderPath: 'C:/folder' }] }
    expect(selectNativeChatWslProject(ordinary, 'folder:folder')).toBe(false)
    expect(
      selectNativeChatWslProject(
        {
          ...ordinary,
          settings: createGlobalSettingsFixture({
            localWindowsRuntimeDefault: { kind: 'wsl', distro: null }
          })
        },
        'folder:folder'
      )
    ).toBeNull()
    expect(
      selectNativeChatWslProject(
        {
          ...ordinary,
          settings: createGlobalSettingsFixture({
            localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
          })
        },
        'folder:folder'
      )
    ).toBe(true)
  })

  it.each(['worktree', 'folder'] as const)(
    'uses the selected %s path with inherited paired ownership and late platform/path',
    (kind) => {
      const id = kind === 'folder' ? 'folder:folder' : 'wt'
      const state = makeState({
        repos: [{ id: 'repo', executionHostId: 'runtime:windows' }],
        projectGroups: [{ id: 'group', executionHostId: 'runtime:windows' }],
        folderWorkspaces: [
          makeFolderWorkspace({ id: 'folder', projectGroupId: 'group', folderPath: path })
        ],
        worktreesByRepo: { repo: [makeWorktree({ id: 'wt', repoId: 'repo', path })] }
      })
      expect(selectNativeChatWslProject(state, id)).toBeNull()
      const answered = {
        ...state,
        runtimeStatusByEnvironmentId: new Map<string, RuntimeEnvironmentStatus>([
          [
            'windows',
            {
              status: {
                ...createCompatibleRuntimeStatusResponse('windows').result,
                hostPlatform: 'win32'
              },
              checkedAt: 1
            }
          ]
        ])
      }
      expect(selectNativeChatWslProject(answered, id)).toBe(true)
      const nativePath = {
        ...answered,
        folderWorkspaces: answered.folderWorkspaces.map((f) => ({ ...f, folderPath: 'C:/folder' })),
        worktreesByRepo: { repo: [makeWorktree({ id: 'wt', repoId: 'repo', path: 'C:/folder' })] }
      }
      expect(selectNativeChatWslProject(nativePath, id)).toBeNull()
    }
  )

  it('waits for a local Windows path instead of retiring from an incomplete row', () => {
    platform.value = 'win32'
    const state = makeState({
      settings,
      projects: [],
      repos: [{ id: 'repo', executionHostId: 'local' }],
      worktreesByRepo: { repo: [makeWorktree({ id: 'wt', repoId: 'repo', path: '' })] }
    })
    expect(selectNativeChatWslProject(state, 'wt')).toBeNull()
    expect(
      selectNativeChatWslProject(
        { ...state, worktreesByRepo: { repo: [{ ...state.worktreesByRepo.repo[0], path }] } },
        'wt'
      )
    ).toBe(true)
  })

  it.each([false, true])('keeps folder and group twins qualified (remote-first %s)', (reverse) => {
    platform.value = 'win32'
    const local = makeFolderWorkspace({
      id: 'folder',
      projectGroupId: 'group',
      executionHostId: 'local',
      folderPath: path
    })
    const remote = { ...local, executionHostId: 'runtime:windows', folderPath: 'C:/remote' }
    const groups = [
      { id: 'group', executionHostId: 'local' },
      { id: 'group', executionHostId: 'runtime:windows' }
    ]
    const state = makeState({
      settings,
      projects: [],
      activeWorktreeId: 'folder:folder',
      activeWorkspaceExecutionHostId: 'local',
      folderWorkspaces: reverse ? [remote, local] : [local, remote],
      projectGroups: reverse ? groups.toReversed() : groups
    })
    expect(selectNativeChatWslProject(state, 'folder:folder')).toBe(true)
    expect(
      selectNativeChatWslProject(
        { ...state, activeWorkspaceExecutionHostId: null },
        'folder:folder'
      )
    ).toBeNull()
  })

  it.each([false, true])(
    'keeps preferred-local workspace/repo/project twins qualified (remote-first %s)',
    (reverse) => {
      platform.value = 'win32'
      const local = makeWorktree({
        id: 'wt',
        repoId: 'repo',
        projectId: 'local-project',
        hostId: 'local',
        path
      })
      const remote = {
        ...local,
        hostId: 'runtime:windows',
        path: 'C:/remote',
        projectId: 'remote-project'
      }
      const repos = [
        { id: 'repo', executionHostId: 'local' },
        { id: 'repo', executionHostId: 'runtime:windows' }
      ]
      const projects = [
        {
          id: 'local-project',
          sourceRepoIds: ['repo'],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        },
        {
          id: 'remote-project',
          sourceRepoIds: ['repo'],
          localWindowsRuntimePreference: { kind: 'windows-host' }
        }
      ]
      const state = makeState({
        settings,
        projects: reverse ? projects.toReversed() : projects,
        repos: reverse ? repos.toReversed() : repos,
        activeWorktreeId: 'wt',
        activeWorkspaceExecutionHostId: 'local',
        worktreesByRepo: { repo: reverse ? [remote, local] : [local, remote] }
      })
      expect(selectNativeChatWslProject(state, 'wt')).toBe(true)
      const selectedProjects = state.projects
      state.projects = state.projects.filter((project) => project.id !== 'local-project')
      // The absent explicit project falls back to its UNC path, never the rival repo match.
      expect(selectNativeChatWslProject(state, 'wt')).toBe(true)
      state.projects = selectedProjects.map((project) =>
        project.id === 'local-project'
          ? { ...project, localWindowsRuntimePreference: { kind: 'windows-host' } }
          : project
      )
      expect(selectNativeChatWslProject(state, 'wt')).toBe(false)
      state.projects = selectedProjects
      expect(selectNativeChatWslProject(state, 'wt')).toBe(true)
      expect(
        selectNativeChatWslProject({ ...state, activeWorkspaceExecutionHostId: null }, 'wt')
      ).toBeNull()
    }
  )
})
